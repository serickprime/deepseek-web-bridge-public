import {
  BROWSER_HEADERS,
  CHALLENGE_PATH,
  CLIENT_HEADERS,
  COMPLETION_PATH,
  SESSION_CREATE_PATH,
  UPSTREAM_USER_AGENT,
} from "../config/constants.js";
import { BridgeError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { collectAuthSecrets, type Redactor } from "../utils/redaction.js";
import { estimateTokenCount } from "../utils/tokenEstimate.js";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "../api/canonical.js";
import type { SessionManager } from "../auth/sessionManager.js";
import type { UpstreamSessionState } from "../sessions/sessionStore.js";
import { PowSolver, parseChallengePayload } from "./pow.js";
import { isDeepSeekRateLimitHint, SseAccumulator, type SseEvent } from "./sseParser.js";
import { DeepSeekPatchParser } from "./updateParser.js";
import { buildToolCatalog, buildToolPromptFromCatalog, selectBridgeTools } from "../tools/toolPrompt.js";
import { SessionCreateLimiter } from "../utils/sessionCreateLimiter.js";
import {
  inspectToolCallFromOutput,
  createToolRetryPrompt,
  sanitizedToolInvocationText,
  toolResultText,
  looksLikeToolIntentText,
  looksLikeFakeToolTrace,
  looksLikeActionSuccessClaim,
  looksLikePromisedActionContinuation,
  inspectCurrentToolCycle,
  isRepeatedFailedToolCall,
  isToolCallSemanticallyAdmissible,
  type CurrentToolCycleEvidence,
  COMPLETION_GUARD_MAX_ATTEMPTS,
  buildUpstreamPrompt,
} from "../tools/toolParser.js";
import { resolveModelSelection, type ModelSelection } from "../config/modelCapabilities.js";

export interface AuthCredentials {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
}

export interface DeepSeekClientOptions {
  baseUrl: string;
  auth: AuthCredentials | null;
  sessionManager: SessionManager;
  solver: PowSolver;
  logger: Logger;
  redactor: Redactor;
  timeoutMs: number;
  maxRetries: number;
}

export interface CompletionCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
}

export interface CompletionResult {
  parentMessageId: number | null;
  content: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

interface CompletionAttemptResult {
  content: string;
  reasoning: string;
  candidateMessageId: number | null;
  usage?: CompletionResult["usage"];
}

const MAX_COMPLETIONS = 2;

type CompletionStage = "completion_headers" | "completion_body";
type ParentState = "none" | "accepted" | "repair_candidate";

interface CompletionTelemetry {
  logger: Logger;
  completionAttempt: number;
  guardAttempt: number;
  parentState: ParentState;
  historyEntries: number;
}

interface RequestDeadline {
  race<T>(operation: Promise<T>): Promise<T>;
  clear(): void;
}

function deadlineError(stage: string): BridgeError {
  return new BridgeError("Upstream request timed out.", {
    code: "UPSTREAM_TIMEOUT",
    status: 504,
    retryable: true,
    upstreamStage: stage,
    causeCode: "deadline_exceeded",
  });
}

function createRequestDeadline(
  timeoutMs: number,
  controller: AbortController,
  getStage: () => string,
): RequestDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(deadlineError(getStage()));
    }, timeoutMs);
  });
  return {
    race: <T>(operation: Promise<T>) => Promise.race([operation, expired]),
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function isMalformedSupportedUpdate(event: SseEvent): boolean {
  if (event.type !== "update" || !event.jsonParseFailed || typeof event.data !== "string") return false;
  const trimmed = event.data.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function failureFields(error: unknown): Record<string, unknown> {
  if (error instanceof BridgeError) {
    return {
      failure_class: error.code,
      cause_code: error.causeCode ?? "unspecified",
      retryable: error.retryable,
    };
  }
  return {
    failure_class: "UNHANDLED_ERROR",
    cause_code: "unhandled_error",
    retryable: false,
  };
}

function childLogger(logger: Logger, fields: Record<string, unknown>): Logger {
  return typeof logger.child === "function" ? logger.child(fields) : logger;
}

export class DeepSeekClient {
  private readonly sessionLimiter = new SessionCreateLimiter();
  private readonly options: DeepSeekClientOptions;
  private auth: AuthCredentials | null = null;
  private authGeneration = 0;

  constructor(options: DeepSeekClientOptions) {
    this.options = { ...options, auth: null };
    if (options.auth) this.setAuth(options.auth);
  }

  setAuth(auth: AuthCredentials): void {
    this.auth = { ...auth };
    this.authGeneration++;
    for (const secret of collectAuthSecrets(auth as unknown as Record<string, unknown>)) {
      this.options.redactor.addSecret(secret);
    }
  }

  clearAuth(): void {
    this.auth = null;
    this.authGeneration++;
  }

  hasAuth(): boolean {
    return this.auth !== null;
  }

  getAuthGeneration(): number {
    return this.authGeneration;
  }

  private assertAuthGeneration(expected: number): void {
    if (expected !== this.authGeneration) {
      throw new BridgeError("DeepSeek credentials changed while the request was running. Retry the request.", {
        code: "SESSION_CONFLICT",
        status: 409,
        retryable: true,
      });
    }
  }

  async ensureSession(
    state: UpstreamSessionState,
    authGeneration = this.authGeneration,
    logger = this.options.logger,
  ): Promise<void> {
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    await this.sessionLimiter.acquire();
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    const body = JSON.stringify({});
    const res = await this.fetch(SESSION_CREATE_PATH, { method: "POST", body }, null, authGeneration, logger, "session_create");
    if (res.status === 401 || res.status === 403) {
      throw new BridgeError(
        `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
        { code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403", status: res.status },
      );
    }
    if (!res.ok) {
      throw new BridgeError(`DeepSeek session creation HTTP ${res.status}`, { code: "UPSTREAM_ERROR", status: res.status });
    }
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.code === "number" && json.code !== 0) {
      throw new BridgeError(`DeepSeek API error: ${json.code} ${json.msg ?? ""}`, { code: "UPSTREAM_ERROR" });
    }
    const data = json.data;
    if (!data || typeof data !== "object") {
      throw new BridgeError("Session creation failed: missing data", { code: "UPSTREAM_ERROR" });
    }
    const dataRecord = data as Record<string, unknown>;
    if (typeof dataRecord.biz_code === "number" && dataRecord.biz_code !== 0) {
      throw new BridgeError(`DeepSeek business error: ${dataRecord.biz_code} ${dataRecord.biz_msg ?? ""}`, { code: "UPSTREAM_ERROR" });
    }
    const bizData = (dataRecord.biz_data && typeof dataRecord.biz_data === "object")
      ? dataRecord.biz_data as Record<string, unknown>
      : dataRecord;
    let id: unknown;
    if (bizData.chat_session && typeof bizData.chat_session === "object") {
      id = (bizData.chat_session as Record<string, unknown>).id;
    }
    if (!id) id = bizData.id;
    if (typeof id !== "string" || !id) {
      throw new BridgeError("Session creation returned no id.", { code: "UPSTREAM_ERROR" });
    }
    this.assertAuthGeneration(authGeneration);
    state.chatSessionId = id;
  }

  async complete(
    request: CanonicalRequest,
    state: UpstreamSessionState,
    callbacks: CompletionCallbacks = {},
    authGeneration = this.authGeneration,
    logger = this.options.logger,
  ): Promise<CompletionResult> {
    const startedAt = Date.now();
    this.assertAuthGeneration(authGeneration);
    const modelSelection = resolveModelSelection(request.model, request.reasoning, request.search);
    const toolCatalog = buildToolCatalog(request.tools);
    const toolPrompt = buildToolPromptFromCatalog(toolCatalog.text);
    const allowedNames = toolCatalog.available.map(t => t.name);
    const hasTools = allowedNames.length > 0;
    const guardEvidence = inspectCurrentToolCycle(request.messages, allowedNames);
    const fulfilledObligationIds = new Set(guardEvidence.fulfilledObligationIds);
    const fulfilledObligationDescriptions = guardEvidence.obligations
      .filter(obligation => fulfilledObligationIds.has(obligation.id))
      .map(obligation => obligation.description);

    const acceptedParent = state.parentMessageId;
    let attemptParent = acceptedParent;
    let attemptParentState: ParentState = acceptedParent === null ? "none" : "accepted";
    let completionAttempt = 1;
    const upstreamPrompt = this.buildPrompt(request, toolPrompt);
    let output = await this.runObservedCompletion(
      upstreamPrompt,
      state.chatSessionId,
      attemptParent,
      authGeneration,
      modelSelection,
      {
        logger,
        completionAttempt,
        guardAttempt: 0,
        parentState: attemptParentState,
        historyEntries: state.history.length,
      },
    );
    if (output.candidateMessageId !== null && output.candidateMessageId !== undefined) {
      attemptParent = output.candidateMessageId;
      attemptParentState = "repair_candidate";
    }

    const inspection = inspectToolCallFromOutput(output, allowedNames);
    let toolCall = inspection.toolCall;
    if (guardEvidence.isInformationalRequest) toolCall = null;
    let malformedToolIntent = inspection.malformedToolIntent && !guardEvidence.isInformationalRequest;
    let sawRepeatedFailedToolCall = isRepeatedFailedToolCall(toolCall, guardEvidence);
    let rejectedToolName = toolCall
      && !sawRepeatedFailedToolCall
      && !isToolCallSemanticallyAdmissible(toolCall, guardEvidence, allowedNames)
      ? toolCall.name
      : undefined;
    let sawSemanticallyRejectedToolCall = rejectedToolName !== undefined;
    let sawMalformedToolIntent = malformedToolIntent;

    // Bounded completion guard loop: retry when the current user turn requires
    // real environment evidence but has no current-cycle tool_result, or when
    // the model produces intent/fabricated tool text instead of tool_call JSON.
    let retries = 0;
    while (shouldRetry(hasTools, toolCall, output.content, output.reasoning, allowedNames, guardEvidence, malformedToolIntent) && retries < COMPLETION_GUARD_MAX_ATTEMPTS - 1) {
      retries++;
      completionAttempt++;
      const repeatedFailedToolName = isRepeatedFailedToolCall(toolCall, guardEvidence)
        ? toolCall?.name
        : undefined;
      const singleMissingFileVerification = guardEvidence.missingObligations.length === 1
        && guardEvidence.missingObligations[0]?.kind === "file_verification"
        && guardEvidence.missingObligations[0].argumentLiterals.length === 1
        ? guardEvidence.missingObligations[0]
        : undefined;
      const singleFileVerificationToolName = singleMissingFileVerification?.requiredToolName
        ?? allowedNames.find(name => name.toLowerCase() === "read");
      const nextMissingFileMutation = guardEvidence.missingObligations[0]?.kind === "file_mutation"
        ? guardEvidence.missingObligations[0]
        : undefined;
      const nextFileMutationToolNames = nextMissingFileMutation?.requiredToolName
        ? allowedNames.filter(name => name.toLowerCase() === nextMissingFileMutation.requiredToolName?.toLowerCase())
        : allowedNames.filter(name => /^(?:write|edit)$/i.test(name));
      const retryInstruction = createToolRetryPrompt(allowedNames, {
        unavailableToolNames: toolCatalog.unavailableNames,
        failedToolNames: guardEvidence.failedToolNames,
        missingActionKinds: guardEvidence.missingActionKinds,
        missingObligations: guardEvidence.missingObligations.map(obligation => obligation.description),
        fulfilledObligations: fulfilledObligationDescriptions,
        staleObligations: guardEvidence.staleObligations.map(obligation => obligation.description),
        inconclusiveObligations: guardEvidence.inconclusiveObligations.map(obligation => obligation.description),
        cardinalityFailures: guardEvidence.cardinalityFailures,
        repeatedFailedToolName,
        rejectedToolName,
        malformedToolIntent,
        singleFileVerificationTarget: singleMissingFileVerification?.argumentLiterals[0],
        singleFileVerificationToolName,
        nextFileMutationToolNames,
        allRequirementsFulfilled: guardEvidence.obligations.length > 0
          && guardEvidence.missingObligations.length === 0,
      });
      const retryPrompt = attemptParentState === "repair_candidate"
        ? retryInstruction
        : [toolCatalog.text, retryInstruction].filter(Boolean).join("\n\n");
      logger.warn("completion_guard_retry", {
        stage: "guard",
        outcome: "retry",
        completion_attempt: completionAttempt,
        guard_attempt: retries,
        failure_class: "TOOL_CALL_REQUIRED",
        cause_code: malformedToolIntent
          ? "malformed_tool_intent"
          : repeatedFailedToolName
            ? "repeated_failed_tool_call"
            : "missing_tool_evidence",
        retryable: true,
      });
      output = await this.runObservedCompletion(
        retryPrompt,
        state.chatSessionId,
        attemptParent,
        authGeneration,
        modelSelection,
        {
          logger,
          completionAttempt,
          guardAttempt: retries,
          parentState: attemptParentState,
          historyEntries: state.history.length,
        },
      );
      if (output.candidateMessageId !== null && output.candidateMessageId !== undefined) {
        attemptParent = output.candidateMessageId;
        attemptParentState = "repair_candidate";
      }
      const retryInspection = inspectToolCallFromOutput(output, allowedNames);
      toolCall = retryInspection.toolCall;
      if (guardEvidence.isInformationalRequest) toolCall = null;
      malformedToolIntent = retryInspection.malformedToolIntent && !guardEvidence.isInformationalRequest;
      sawRepeatedFailedToolCall ||= isRepeatedFailedToolCall(toolCall, guardEvidence);
      rejectedToolName = toolCall
        && !isRepeatedFailedToolCall(toolCall, guardEvidence)
        && !isToolCallSemanticallyAdmissible(toolCall, guardEvidence, allowedNames)
        ? toolCall.name
        : undefined;
      sawSemanticallyRejectedToolCall ||= rejectedToolName !== undefined;
      sawMalformedToolIntent ||= malformedToolIntent;
      if (toolCall) {
        output = { ...output, content: "", reasoning: "" };
      }
    }

    if (shouldRetry(hasTools, toolCall, output.content, output.reasoning, allowedNames, guardEvidence, malformedToolIntent)) {
      logger.warn("completion_guard_rejected", {
        stage: "guard",
        outcome: "failure",
        completion_attempt: completionAttempt,
        guard_attempt: retries,
        latency_ms: Date.now() - startedAt,
        failure_class: "TOOL_CALL_REQUIRED",
        cause_code: sawMalformedToolIntent
          ? "malformed_tool_intent"
          : sawRepeatedFailedToolCall
            ? "repeated_failed_tool_call"
            : sawSemanticallyRejectedToolCall
              ? "semantically_redundant_tool_call"
              : "missing_tool_evidence",
        retryable: true,
        requires_environment_tool_result: guardEvidence.requiresEnvironmentToolResult,
        requires_action_tool_result: guardEvidence.requiresActionToolResult,
        has_current_tool_result: guardEvidence.hasCurrentToolResult,
        has_successful_current_tool_result: guardEvidence.hasSuccessfulCurrentToolResult,
        has_failed_current_tool_result: guardEvidence.hasFailedCurrentToolResult,
        missing_obligation_count: guardEvidence.missingObligations.length,
        stale_obligation_count: guardEvidence.staleObligations.length,
        inconclusive_obligation_count: guardEvidence.inconclusiveObligations.length,
        cardinality_failure_count: guardEvidence.cardinalityFailures.length,
        missing_obligation_kinds: guardEvidence.missingActionKinds,
        repeated_failed_tool_call: sawRepeatedFailedToolCall,
        semantically_redundant_tool_call: sawSemanticallyRejectedToolCall,
        malformed_tool_intent: sawMalformedToolIntent,
      });
      throw new BridgeError(
        sawRepeatedFailedToolCall
          ? "DeepSeek repeated a tool call that already failed in this user action cycle and did not provide a safe alternative or a non-empty honest failure. The failed action was not executed again."
          : sawMalformedToolIntent
            ? "DeepSeek produced malformed tool-call syntax and did not repair it within the bounded retry limit. No raw tool JSON was returned and no tool was executed."
            : sawSemanticallyRejectedToolCall
              ? "DeepSeek proposed a tool action that did not correspond to a still-unverified current-user obligation. The redundant action was not executed, and no fabricated success result was returned."
              : "DeepSeek did not produce the required real tool call for every current-user obligation. One or more requested actions or exact values remain unverified, so no fabricated success result was returned.",
        { code: "TOOL_CALL_REQUIRED", status: 502, retryable: true },
      );
    }

    if (toolCall) {
      callbacks.onToolCall?.(toolCall.name, toolCall.arguments as Record<string, unknown>);
    }

    this.assertAuthGeneration(authGeneration);
    const acceptedCandidateMessageId = output.candidateMessageId;
    const result: CompletionResult = {
      parentMessageId: acceptedCandidateMessageId ?? acceptedParent,
      content: toolCall ? "" : output.content,
      toolCall: toolCall ? { name: toolCall.name, args: toolCall.arguments as Record<string, unknown> } : undefined,
      usage: output.usage,
    };
    if (acceptedCandidateMessageId !== null && acceptedCandidateMessageId !== undefined) {
      state.parentMessageId = acceptedCandidateMessageId;
    }
    logger.info("completion_accepted", {
      stage: "guard",
      outcome: "success",
      completion_attempt: completionAttempt,
      guard_attempt: retries,
      latency_ms: Date.now() - startedAt,
      history_entries: state.history.length,
      parent_state: acceptedCandidateMessageId == null ? (acceptedParent === null ? "none" : "accepted") : "accepted",
      tool_name: toolCall?.name,
    });
    return result;
  }

  private async runObservedCompletion(
    prompt: string,
    chatSessionId: string | null,
    requestParentMessageId: number | null,
    authGeneration: number,
    model: ModelSelection,
    telemetry: CompletionTelemetry,
  ): Promise<CompletionAttemptResult> {
    const attemptLogger = childLogger(telemetry.logger, {
      completion_attempt: telemetry.completionAttempt,
      guard_attempt: telemetry.guardAttempt,
      history_entries: telemetry.historyEntries,
      parent_state: telemetry.parentState,
    });
    const startedAt = Date.now();
    attemptLogger.info("completion_attempt_start", { stage: "challenge", outcome: "start" });
    try {
      const result = await this.runCompletion(
        prompt,
        chatSessionId,
        requestParentMessageId,
        authGeneration,
        model,
        attemptLogger,
      );
      attemptLogger.info("completion_attempt_done", {
        stage: "completion_body",
        outcome: "success",
        latency_ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      attemptLogger.warn("completion_attempt_failed", {
        stage: error instanceof BridgeError ? error.upstreamStage ?? "completion" : "completion",
        outcome: "failure",
        latency_ms: Date.now() - startedAt,
        ...failureFields(error),
      });
      throw error;
    }
  }

  private async runCompletion(
    prompt: string,
    chatSessionId: string | null,
    requestParentMessageId: number | null,
    authGeneration: number,
    model: ModelSelection,
    logger: Logger,
  ): Promise<CompletionAttemptResult> {
    const payload = {
      chat_session_id: chatSessionId,
      parent_message_id: requestParentMessageId,
      prompt,
      ref_file_ids: [],
      model_type: model.upstreamModelType,
      thinking_enabled: model.thinkingEnabled,
      search_enabled: model.searchEnabled,
      action: null,
      preempt: false,
    };
    const challenge = await this.fetchChallenge(authGeneration, logger);
    const solution = await this.options.solver.solve(challenge, logger);
    const controller = new AbortController();
    let stage: CompletionStage = "completion_headers";
    const deadline = createRequestDeadline(this.options.timeoutMs, controller, () => stage);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let result: CompletionAttemptResult | null = null;
    let primaryError: unknown;
    let candidateMessageId: number | null = null;
    let content = "";
    let reasoning = "";
    let usage: CompletionResult["usage"];
    let receivedBytes = false;

    try {
      this.assertAuthGeneration(authGeneration);
      logger.info("completion_transport_start", {
        stage: "completion_headers",
        outcome: "start",
        transport_attempt: 1,
      });
      const res = await deadline.race(fetch(`${this.options.baseUrl}${COMPLETION_PATH}`, {
        method: "POST",
        headers: this.buildHeaders(solution, authGeneration),
        body: JSON.stringify(payload),
        signal: controller.signal,
      }));
      this.assertAuthGeneration(authGeneration);
      if (!res.ok && res.body) reader = res.body.getReader();

      if (res.status === 401 || res.status === 403) {
        throw new BridgeError(
          `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
          {
            code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403",
            status: res.status,
            upstreamStage: "completion_headers",
            causeCode: `http_${res.status}`,
          },
        );
      }
      if (res.status === 429) {
        throw new BridgeError("DeepSeek upstream rate limit reached. Try again later.", {
          code: "DEEPSEEK_RATE_LIMIT",
          status: 429,
          retryable: true,
          upstreamStage: "completion_headers",
          causeCode: "http_429",
        });
      }
      if (!res.ok) {
        logger.warn("upstream_error_response", {
          stage: "completion_headers",
          outcome: "failure",
          failure_class: "UPSTREAM_ERROR",
          cause_code: `http_${res.status}`,
          retryable: res.status >= 500,
          status: res.status,
          prompt_bytes: Buffer.byteLength(payload.prompt, "utf8"),
        });
        throw new BridgeError(`Upstream completion failed with HTTP ${res.status}.`, {
          code: "UPSTREAM_ERROR",
          status: 502,
          retryable: res.status >= 500,
          upstreamStage: "completion_headers",
          causeCode: `http_${res.status}`,
        });
      }
      if (res.body === null) {
        throw new BridgeError("DeepSeek returned an empty completion stream.", {
          code: "STREAM_INCOMPLETE",
          status: 502,
          retryable: true,
          upstreamStage: "completion_body",
          causeCode: "empty_stream",
        });
      }

      stage = "completion_body";
      reader = res.body.getReader();
      const decoder = new TextDecoder();
      const accumulator = new SseAccumulator();
      const parser = new DeepSeekPatchParser();

      const processEvents = (events: SseEvent[]): "success" | null => {
        for (const event of events) {
          if (isDeepSeekRateLimitHint(event)) {
            throw new BridgeError("DeepSeek upstream rate limit reached. Try again later.", {
              code: "DEEPSEEK_RATE_LIMIT",
              status: 429,
              retryable: true,
              upstreamStage: "completion",
              causeCode: "rate_limit_reached",
            });
          }
          if (isMalformedSupportedUpdate(event)) {
            throw new BridgeError("DeepSeek returned a malformed supported SSE update.", {
              code: "STREAM_PARSE_FAILED",
              status: 502,
              retryable: false,
              upstreamStage: "completion_body",
              causeCode: "malformed_update",
            });
          }
          if (event.type !== "update") continue;
          const chunk = parser.apply(event.data);
          if (!chunk) continue;
          if (chunk.messageId !== undefined) candidateMessageId = chunk.messageId;
          if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
          if (chunk.delta) content += chunk.delta;
          if (chunk.usage) usage = chunk.usage;
          if (chunk.terminal === "incomplete") {
            throw new BridgeError("DeepSeek marked the completion stream incomplete.", {
              code: "STREAM_INCOMPLETE",
              status: 502,
              retryable: true,
              upstreamStage: "completion_body",
              causeCode: "upstream_incomplete",
            });
          }
          if (chunk.terminal === "success") return "success";
        }
        return null;
      };

      let terminal: "success" | null = null;
      while (!terminal) {
        const read = await deadline.race(reader.read());
        if (read.done) {
          const finalText = decoder.decode();
          if (finalText) terminal = processEvents(accumulator.push(finalText));
          if (!terminal) terminal = processEvents(accumulator.flush());
          if (!terminal) {
            throw new BridgeError("DeepSeek completion ended before an authoritative terminal event.", {
              code: "STREAM_INCOMPLETE",
              status: 502,
              retryable: true,
              upstreamStage: "completion_body",
              causeCode: receivedBytes ? "eof_before_terminal" : "empty_stream",
            });
          }
          break;
        }
        if (read.value.byteLength > 0) receivedBytes = true;
        const raw = decoder.decode(read.value, { stream: true });
        if (raw.trimStart().startsWith("{")) {
          try {
            const parsed = JSON.parse(raw) as { code?: unknown; msg?: unknown; data?: { biz_code?: unknown; biz_msg?: unknown } };
            const bizCode = parsed.data?.biz_code;
            if (typeof parsed.code === "number" && (parsed.code !== 0 || (typeof bizCode === "number" && bizCode !== 0))) {
              const message = parsed.msg ?? parsed.data?.biz_msg ?? "unknown";
              throw new BridgeError(`Upstream API error: ${String(message)}`, {
                code: "UPSTREAM_ERROR",
                status: 502,
                retryable: true,
                upstreamStage: "completion_body",
                causeCode: "upstream_api_error",
              });
            }
          } catch (error) {
            if (error instanceof BridgeError) throw error;
          }
        }
        terminal = processEvents(accumulator.push(raw));
      }

      result = { content, reasoning, candidateMessageId, usage };
    } catch (error) {
      primaryError = this.normalizeCompletionError(error, stage);
      controller.abort();
    }

    if (reader) {
      try {
        void Promise.resolve(reader.cancel()).catch(() => {});
      } catch {}
      try {
        reader.releaseLock();
      } catch {}
    }
    deadline.clear();

    if (primaryError) throw primaryError;
    if (!result) {
      throw new BridgeError("DeepSeek completion did not produce a terminal result.", {
        code: "STREAM_INCOMPLETE",
        status: 502,
        retryable: true,
        upstreamStage: "completion_body",
        causeCode: receivedBytes ? "eof_before_terminal" : "empty_stream",
      });
    }
    return result;
  }

  private buildPrompt(
    request: CanonicalRequest,
    toolPrompt: string,
  ): string {
    const parts: string[] = [];
    if (request.system) parts.push(`System: ${request.system}`);
    if (toolPrompt) parts.push(toolPrompt);

    // Use FreeDeepseekAPI-style message formatting (system handled inside buildUpstreamPrompt for anthropic)
    const kind = this.detectProtocol(request);
    const prompt = buildUpstreamPrompt(
      { messages: this.canonicalToRaw(request.messages) },
      kind,
      null,
    );
    if (prompt) parts.push(prompt);

    return parts.filter(Boolean).join("\n\n") || "continue";
  }

  private detectProtocol(request: CanonicalRequest): string {
    // If messages have Anthropic-style tool_use/tool_result parts, use anthropic
    for (const msg of request.messages) {
      for (const part of msg.parts) {
        if (part.type === "tool_use" || part.type === "tool_result") return "anthropic";
      }
    }
    return "openai";
  }

  private canonicalToRaw(messages: CanonicalMessage[]): Record<string, unknown>[] {
    const toolNameById = buildToolUseIdMap(messages);
    return messages.map(msg => {
      const parts: string[] = [];
      for (const part of msg.parts) {
        if (part.type === "text") {
          parts.push(part.text ?? "");
        } else if (part.type === "tool_use") {
          parts.push(sanitizedToolInvocationText(
            part.toolCall?.name ?? "",
            part.toolCall?.id ?? "",
          ));
        } else if (part.type === "tool_result") {
          const toolUseId = part.toolResult?.toolUseId ?? "";
          const toolName = toolNameById.get(toolUseId) ?? "unknown";
          parts.push(toolResultText(
            toolName,
            toolUseId,
            part.toolResult?.content ?? "",
            part.toolResult?.isError === true,
          ));
        }
      }
      return {
        role: msg.role,
        content: parts.filter(Boolean).join("\n"),
      };
    });
  }

  private async fetchChallenge(
    authGeneration: number,
    logger: Logger,
  ): Promise<ReturnType<typeof parseChallengePayload> & { expireAt: number }> {
    const body = JSON.stringify({ target_path: COMPLETION_PATH });
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      const controller = new AbortController();
      let stage = "challenge_headers";
      const deadline = createRequestDeadline(this.options.timeoutMs, controller, () => stage);
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let attemptError: unknown;
      let challenge: (ReturnType<typeof parseChallengePayload> & { expireAt: number }) | null = null;

      try {
        this.assertAuthGeneration(authGeneration);
        const res = await deadline.race(fetch(`${this.options.baseUrl}${CHALLENGE_PATH}`, {
          method: "POST",
          headers: this.buildHeaders(null, authGeneration),
          body,
          signal: controller.signal,
        }));
        this.assertAuthGeneration(authGeneration);
        if (!res.ok && res.body) reader = res.body.getReader();

        if (res.status === 401 || res.status === 403) {
          throw new BridgeError(
            `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
            {
              code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403",
              status: res.status,
              upstreamStage: "challenge_headers",
              causeCode: `http_${res.status}`,
            },
          );
        }
        if (!res.ok) {
          throw new BridgeError(`DeepSeek challenge request failed with HTTP ${res.status}.`, {
            code: "UPSTREAM_ERROR",
            status: 502,
            retryable: res.status === 429 || res.status >= 500,
            upstreamStage: "challenge_headers",
            causeCode: `http_${res.status}`,
          });
        }
        if (!res.body) {
          throw new BridgeError("DeepSeek challenge response had no body.", {
            code: "POW_CHALLENGE_FAILED",
            status: 502,
            retryable: true,
            upstreamStage: "challenge_body",
            causeCode: "empty_body",
          });
        }

        stage = "challenge_body";
        reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (true) {
          const read = await deadline.race(reader.read());
          if (read.done) {
            text += decoder.decode();
            break;
          }
          text += decoder.decode(read.value, { stream: true });
        }
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(text) as Record<string, unknown>;
        } catch {
          throw new BridgeError("PoW challenge response was not valid JSON.", {
            code: "POW_FORMAT_CHANGED",
            status: 502,
            retryable: false,
            upstreamStage: "challenge_body",
            causeCode: "invalid_json",
          });
        }
        challenge = parseChallengePayload(json);
        if (!challenge) {
          throw new BridgeError("PoW challenge payload changed.", {
            code: "POW_FORMAT_CHANGED",
            status: 502,
            retryable: false,
            upstreamStage: "challenge_body",
            causeCode: "invalid_payload",
          });
        }
      } catch (error) {
        attemptError = error instanceof BridgeError
          ? error
          : new BridgeError(stage === "challenge_body" ? "Upstream challenge body failed." : "Upstream challenge request failed.", {
              code: error instanceof Error && error.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
              status: error instanceof Error && error.name === "AbortError" ? 504 : 502,
              retryable: true,
              upstreamStage: stage,
              causeCode: error instanceof Error && error.name === "AbortError" ? "deadline_exceeded" : "transport_error",
            });
        controller.abort();
      }

      if (reader) {
        try {
          const cancellation = Promise.resolve(reader.cancel());
          if (attemptError) void cancellation.catch(() => {});
          else await deadline.race(cancellation);
        } catch (error) {
          if (!attemptError && error instanceof BridgeError) attemptError = error;
        }
        try {
          reader.releaseLock();
        } catch {}
      }
      deadline.clear();

      if (challenge) return challenge;
      lastError = attemptError;
      const canRetry = attemptError instanceof BridgeError
        && attemptError.retryable
        && attemptError.code !== "SESSION_CONFLICT"
        && attempt < this.options.maxRetries;
      logger.warn("upstream_fetch_retry", {
        stage,
        outcome: canRetry ? "retry" : "failure",
        transport_attempt: attempt + 1,
        ...failureFields(attemptError),
        will_retry: canRetry,
      });
      if (!canRetry) throw attemptError;
    }

    throw lastError;
  }

  private buildHeaders(
    solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null,
    authGeneration: number,
  ): Record<string, string> {
    this.assertAuthGeneration(authGeneration);
    const auth = this.auth;
    if (!auth || (!auth.token && !auth.cookie)) {
      throw new BridgeError("DeepSeek credentials are not configured. Use AUTH in Bridge Console.", {
        code: "AUTH_MISSING",
        status: 401,
      });
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...CLIENT_HEADERS,
      ...BROWSER_HEADERS,
      "user-agent": UPSTREAM_USER_AGENT,
      authorization: `Bearer ${auth.token}`,
      cookie: auth.cookie,
    };
    if (auth.hifLeim) headers["x-hif-leim"] = auth.hifLeim;
    if (auth.hifDliq) headers["x-hif-dliq"] = auth.hifDliq;
    if (solution) {
      const powJson = JSON.stringify({
        algorithm: solution.algorithm,
        challenge: solution.challenge,
        salt: solution.salt,
        answer: solution.answer,
        signature: solution.signature,
        target_path: COMPLETION_PATH,
      });
      headers["x-ds-pow-response"] = Buffer.from(powJson).toString("base64");
    }
    return headers;
  }

  private normalizeCompletionError(error: unknown, stage: CompletionStage): BridgeError {
    if (error instanceof BridgeError) return error;
    if (error instanceof Error && error.name === "AbortError") return deadlineError(stage);
    return new BridgeError(
      stage === "completion_body" ? "Upstream completion body failed." : "Upstream completion request failed.",
      {
        code: "UPSTREAM_ERROR",
        status: 502,
        retryable: true,
        upstreamStage: stage,
        causeCode: stage === "completion_body" ? "body_read_failed" : "transport_error",
      },
    );
  }

  private async fetch(
    path: string,
    init: { method: string; body?: string },
    solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null,
    authGeneration = this.authGeneration,
    logger = this.options.logger,
    stage = "upstream_fetch",
  ): Promise<Response> {
    this.assertAuthGeneration(authGeneration);
    const { baseUrl, timeoutMs, maxRetries } = this.options;
    const headers = this.buildHeaders(solution, authGeneration);
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.assertAuthGeneration(authGeneration);
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          method: init.method,
          headers,
          body: init.body,
          signal: controller.signal,
        });
        this.assertAuthGeneration(authGeneration);
        return res;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof BridgeError);
        logger.warn("upstream_fetch_retry", {
          stage,
          outcome: retryable && attempt < maxRetries ? "retry" : "failure",
          transport_attempt: attempt + 1,
          failure_class: error instanceof BridgeError ? error.code : "UPSTREAM_ERROR",
          cause_code: error instanceof Error && error.name === "AbortError" ? "deadline_exceeded" : "transport_error",
          retryable,
        });
        if (!retryable) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    const aborted = lastError instanceof Error && lastError.name === "AbortError";
    throw new BridgeError(aborted ? "Upstream request timed out." : "Upstream request failed.", {
      code: aborted ? "UPSTREAM_TIMEOUT" : "UPSTREAM_ERROR",
      status: aborted ? 504 : 502,
      retryable: true,
    });
  }

  estimatePromptTokens(request: CanonicalRequest): number {
    let total = 0;
    for (const message of request.messages) {
      for (const part of message.parts) {
        if (part.text) total += estimateTokenCount(part.text);
        if (part.toolResult?.content) total += estimateTokenCount(part.toolResult.content);
      }
    }
    if (request.system) total += estimateTokenCount(request.system);
    return total;
  }
}

export function shouldRetry(
  hasTools: boolean,
  toolCall: unknown,
  content: string,
  reasoning: string,
  allowedToolNames: string[] = [],
  evidence?: CurrentToolCycleEvidence,
  malformedToolIntent = false,
): boolean {
  if (!hasTools) return false;
  if (toolCall) {
    return isRepeatedFailedToolCall(toolCall, evidence)
      || !isToolCallSemanticallyAdmissible(toolCall, evidence, allowedToolNames);
  }
  if (malformedToolIntent && evidence && !evidence.isInformationalRequest) return true;
  if (evidence?.requiresEnvironmentToolResult || evidence?.requiresActionToolResult) {
    if (evidence.hasUnavailableToolFailure) return true;
    if (!evidence.hasFailedCurrentToolResult) return true;
    if (content.trim() === "") return true;
    if (/<tool_calls?\b|<invoke\b/i.test(content)) return true;
    if (looksLikePromisedActionContinuation(content)) return true;
    if (content.trim() !== "" && looksLikeActionSuccessClaim(content)) return true;
    if (content.trim() !== "" && looksLikeToolIntentText(content, allowedToolNames)) return true;
    if (content.trim() !== "" && looksLikeFakeToolTrace(content, allowedToolNames)) return true;
    return false;
  }
  if (evidence?.hasSuccessfulCurrentToolResult) return false;
  if (evidence?.hasFailedCurrentToolResult && content.trim() === "") return true;
  if (content.trim() === "" && reasoning.trim() !== "") return true;
  if (content.trim() !== "" && looksLikeToolIntentText(content, allowedToolNames)) return true;
  if (content.trim() !== "" && looksLikeFakeToolTrace(content, allowedToolNames)) return true;
  return false;
}

export function buildToolNames(tools: CanonicalTool[]): Set<string> {
  return new Set(selectBridgeTools(tools).available.map(tool => tool.name));
}

export function toolsToCanonical(tools: CanonicalTool[]): CanonicalTool[] {
  return tools;
}

export function buildToolUseIdMap(messages: CanonicalMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === "tool_use" && part.toolCall?.id && part.toolCall?.name) {
        map.set(part.toolCall.id, part.toolCall.name);
      }
    }
  }
  return map;
}
