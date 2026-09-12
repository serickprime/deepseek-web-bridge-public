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
import type { CanonicalMessage, CanonicalRequest, CanonicalTool, CanonicalToolCall } from "../api/canonical.js";
import type { GenericToolRuntimeMode } from "../config/env.js";
import type { SessionManager } from "../auth/sessionManager.js";
import type { UpstreamSessionState } from "../sessions/sessionStore.js";
import { PowSolver, parseChallengePayload } from "./pow.js";
import { isDeepSeekRateLimitHint, SseAccumulator, type SseEvent } from "./sseParser.js";
import { DeepSeekPatchParser } from "./updateParser.js";
import { buildToolCatalog, buildToolPromptFromCatalog, selectBridgeTools } from "../tools/toolPrompt.js";
import { SessionCreateLimiter } from "../utils/sessionCreateLimiter.js";
import {
  inspectStrictTurnFromOutput,
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
  type StrictBridgeTurn,
} from "../tools/toolParser.js";
import {
  admitLedgerToolCall,
  executableLedgerActions,
  ledgerActionDescription,
  ledgerActionToolNames,
  ledgerComplete,
  outstandingLedgerActions,
  type ActionLedger,
  type LedgerAdmission,
} from "../tools/actionLedger.js";
import {
  evaluateFinish,
  failedLedgerCallIds,
  successfulLedgerCallIds,
  type FinishGuardDecision,
} from "../tools/finishGuard.js";
import { resolveModelSelection, type ModelSelection } from "../config/modelCapabilities.js";
import {
  UpstreamController,
  type UpstreamRequestLease,
  type UpstreamRetryBudget,
} from "./upstreamController.js";
import {
  executionPlanPrompt,
  initialExecutionPlanRequired,
  routeExecutionPlanUpdate,
  type PlanUpdateDecision,
} from "../tools/executionPlan.js";

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
  upstreamController?: UpstreamController;
  genericToolRuntimeMode?: GenericToolRuntimeMode;
}

export interface CompletionCallbacks {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: Record<string, unknown>) => void;
  actionLedger?: ActionLedger;
  onPlanUpdate?: () => void | Promise<void>;
  signal?: AbortSignal;
}

export interface CompletionResult {
  parentMessageId: number | null;
  content: string;
  toolCall?: { name: string; args: Record<string, unknown>; actionId?: string };
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
  let rejectCancelled: ((reason: Error) => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancelled = reject;
  });
  const onAbort = (): void => rejectCancelled?.(new DOMException("Request aborted.", "AbortError"));
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener("abort", onAbort, { once: true });
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(deadlineError(getStage()));
    }, timeoutMs);
  });
  return {
    race: <T>(operation: Promise<T>) => Promise.race([operation, expired, cancelled]),
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
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
  private readonly upstreamController: UpstreamController;
  private auth: AuthCredentials | null = null;
  private authGeneration = 0;

  constructor(options: DeepSeekClientOptions) {
    this.options = { ...options, auth: null };
    this.upstreamController = options.upstreamController ?? new UpstreamController({
      minDelayMs: 0,
      rateLimitBackoffMs: Array.from({ length: options.maxRetries }, () => 0),
      transientBackoffMs: Array.from({ length: options.maxRetries }, () => 0),
      jitterRatio: 0,
    });
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
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    await this.sessionLimiter.acquire();
    this.assertAuthGeneration(authGeneration);
    if (state.chatSessionId) return;
    const id = await this.upstreamController.run(
      (lease, attempt) => lease.request(
        () => this.createSessionOnce(authGeneration, signal),
        attempt,
      ),
      { logger, signal },
    );
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
    const genericToolRuntimeMode = this.options.genericToolRuntimeMode ?? "legacy";
    const toolPrompt = buildToolPromptFromCatalog(toolCatalog.text, {
      planUpdates: genericToolRuntimeMode === "enabled",
    });
    const allowedNames = toolCatalog.available.map(t => t.name);
    const hasTools = allowedNames.length > 0;
    const guardEvidence = inspectCurrentToolCycle(request.messages, allowedNames);
    const actionLedger = callbacks.actionLedger;
    const fulfilledObligationIds = new Set(guardEvidence.fulfilledObligationIds);
    const fulfilledObligationDescriptions = guardEvidence.obligations
      .filter(obligation => fulfilledObligationIds.has(obligation.id))
      .map(obligation => obligation.description);

    const acceptedParent = state.parentMessageId;
    let attemptParent = acceptedParent;
    let attemptParentState: ParentState = acceptedParent === null ? "none" : "accepted";
    let completionAttempt = 1;
    const retryBudget = this.upstreamController.createBudget();
    const upstreamPrompt = this.buildPrompt(
      request,
      toolPrompt,
      actionLedger,
      genericToolRuntimeMode,
    );
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
      callbacks.signal,
      retryBudget,
    );
    if (output.candidateMessageId !== null && output.candidateMessageId !== undefined) {
      attemptParent = output.candidateMessageId;
      attemptParentState = "repair_candidate";
    }

    const inspection = inspectStrictTurnFromOutput(output, toolCatalog.available);
    let strictTurnReason = inspection.reason;
    let strictTurn = inspection.turn;
    let toolCall = inspection.toolCall;
    const processPlanUpdate = async (
      turn: StrictBridgeTurn | null,
      proposedToolCall: CanonicalToolCall | null,
    ): Promise<{ decision?: PlanUpdateDecision; toolCall: CanonicalToolCall | null }> => {
      if (turn?.type !== "plan_update") return { toolCall: proposedToolCall };
      if (!actionLedger) return { toolCall: null };

      if (genericToolRuntimeMode === "enabled") {
        const previewLedger = structuredClone(actionLedger);
        const preview = routeExecutionPlanUpdate(
          genericToolRuntimeMode,
          previewLedger,
          turn.baseRevision,
          turn.steps,
          toolCatalog.available,
        );
        if (!preview.applied) {
          logger.warn("execution_plan_atomic_rejected", {
            stage: "execution_plan",
            outcome: "rejected",
            reason: preview.decision.reason,
            base_revision: turn.baseRevision,
            step_count: turn.steps.length,
          });
          return { decision: preview.decision, toolCall: null };
        }

        if (!turn.nextToolCall && executableLedgerActions(previewLedger).length > 0) {
          logger.warn("execution_plan_atomic_rejected", {
            stage: "execution_plan",
            outcome: "rejected",
            reason: "next_tool_required",
            base_revision: turn.baseRevision,
            step_count: turn.steps.length,
          });
          return {
            decision: { allowed: false, reason: "next_tool_required" },
            toolCall: null,
          };
        }

        if (turn.nextToolCall) {
          const previewAdmission = admitLedgerToolCall(previewLedger, turn.nextToolCall);
          if (!previewAdmission.allowed) {
            logger.warn("execution_plan_atomic_rejected", {
              stage: "execution_plan",
              outcome: "rejected",
              reason: "next_tool_not_admissible",
              admission_reason: previewAdmission.reason,
              base_revision: turn.baseRevision,
              step_count: turn.steps.length,
              tool_name: turn.nextToolCall.name,
            });
            return {
              decision: { allowed: false, reason: "next_tool_not_admissible" },
              toolCall: null,
            };
          }
        }

        if (preview.decision.reason !== "replayed") {
          actionLedger.actions = previewLedger.actions;
          actionLedger.unresolvedIntent = previewLedger.unresolvedIntent;
          actionLedger.plan = previewLedger.plan;
          actionLedger.updatedAt = previewLedger.updatedAt;
          await callbacks.onPlanUpdate?.();
        }
        return { decision: preview.decision, toolCall: turn.nextToolCall ?? null };
      }

      const rollout = routeExecutionPlanUpdate(
        genericToolRuntimeMode,
        actionLedger,
        turn.baseRevision,
        turn.steps,
        toolCatalog.available,
      );
      if (rollout.mode === "shadow") {
        logger.info("execution_plan_shadow_decision", {
          stage: "execution_plan",
          outcome: rollout.shadowDecision?.allowed ? "would_apply" : "would_reject",
          reason: rollout.shadowDecision?.reason,
          base_revision: turn.baseRevision,
          step_count: turn.steps.length,
          legacy_action_count: actionLedger.actions.length,
          legacy_executable_count: executableLedgerActions(actionLedger).length,
        });
      }
      if (rollout.applied) await callbacks.onPlanUpdate?.();
      return {
        decision: rollout.decision,
        toolCall: rollout.applied ? proposedToolCall : null,
      };
    };
    let processedPlanUpdate = await processPlanUpdate(strictTurn, toolCall);
    let planUpdateDecision = processedPlanUpdate.decision;
    toolCall = processedPlanUpdate.toolCall;
    if (!actionLedger && guardEvidence.isInformationalRequest) toolCall = null;
    let malformedToolIntent = inspection.malformedToolIntent
      && (actionLedger ? true : !guardEvidence.isInformationalRequest);
    let sawRepeatedFailedToolCall = isRepeatedFailedToolCall(toolCall, guardEvidence);
    let ledgerAdmission: LedgerAdmission | undefined = toolCall && actionLedger
      ? genericToolRuntimeMode === "enabled" && initialExecutionPlanRequired(actionLedger)
        ? { allowed: false, reason: "no_action" }
        : admitLedgerToolCall(actionLedger, toolCall)
      : undefined;
    let finishDecision: FinishGuardDecision | undefined = actionLedger && strictTurn?.type === "finish"
      ? evaluateFinish(actionLedger, strictTurn)
      : undefined;
    let rejectedToolName = toolCall && (actionLedger
      ? !ledgerAdmission?.allowed
      : !sawRepeatedFailedToolCall && !isToolCallSemanticallyAdmissible(toolCall, guardEvidence, allowedNames))
      ? toolCall.name
      : undefined;
    let sawSemanticallyRejectedToolCall = rejectedToolName !== undefined;
    let sawMalformedToolIntent = malformedToolIntent;
    const requiresRetry = (): boolean => actionLedger
      ? shouldRetryWithLedger(
          hasTools,
          toolCall,
          output.content,
          output.reasoning,
          allowedNames,
          actionLedger,
          ledgerAdmission,
          malformedToolIntent,
          strictTurn,
          finishDecision,
        )
      : shouldRetry(hasTools, toolCall, output.content, output.reasoning, allowedNames, guardEvidence, malformedToolIntent);

    // Bounded completion guard loop: retry when the current user turn requires
    // real environment evidence but has no current-cycle tool_result, or when
    // the model produces intent/fabricated tool text instead of tool_call JSON.
    let retries = 0;
    while (requiresRetry() && retries < COMPLETION_GUARD_MAX_ATTEMPTS - 1) {
      retries++;
      completionAttempt++;
      let useLegacyFallbackPrompt = false;
      const continueFromAppliedPlan = strictTurn?.type === "plan_update"
        && planUpdateDecision?.allowed === true;
      const restartFromRejectedPlan = strictTurn?.type === "plan_update"
        && planUpdateDecision?.allowed !== true;
      if (continueFromAppliedPlan || restartFromRejectedPlan) {
        attemptParent = acceptedParent;
        attemptParentState = acceptedParent === null ? "none" : "accepted";
      }
      if (genericToolRuntimeMode === "enabled"
        && retries === COMPLETION_GUARD_MAX_ATTEMPTS - 1
        && actionLedger
        && initialExecutionPlanRequired(actionLedger)
        && strictTurn?.type !== "plan_update"
        && actionLedger.actions.length > 0) {
        actionLedger.unresolvedIntent = false;
        actionLedger.updatedAt = Date.now();
        attemptParent = acceptedParent;
        attemptParentState = acceptedParent === null ? "none" : "accepted";
        useLegacyFallbackPrompt = true;
        await callbacks.onPlanUpdate?.();
        logger.warn("execution_plan_legacy_fallback", {
          stage: "execution_plan",
          outcome: "fallback",
          reason: "initial_plan_repair_exhausted",
          legacy_action_count: actionLedger.actions.length,
        });
      }
      const repeatedFailedToolName = actionLedger && ledgerAdmission?.reason === "repeated_failure"
        ? toolCall?.name
        : isRepeatedFailedToolCall(toolCall, guardEvidence)
        ? toolCall?.name
        : undefined;
      const ledgerOutstanding = actionLedger ? outstandingLedgerActions(actionLedger) : [];
      const ledgerExecutable = actionLedger ? executableLedgerActions(actionLedger) : [];
      const singleLedgerVerification = ledgerExecutable.length === 1
        && ledgerExecutable[0]?.kind === "file_verification"
        && ledgerExecutable[0].target
        ? ledgerExecutable[0]
        : undefined;
      const singleMissingFileVerification = actionLedger ? undefined
        : guardEvidence.missingObligations.length === 1
          && guardEvidence.missingObligations[0]?.kind === "file_verification"
          && guardEvidence.missingObligations[0].argumentLiterals.length === 1
          ? guardEvidence.missingObligations[0]
          : undefined;
      const singleFileVerificationToolName = singleLedgerVerification?.requiredToolNames[0]
        ?? singleMissingFileVerification?.requiredToolName
        ?? allowedNames.find(name => name.toLowerCase() === "read");
      const nextLedgerMutation = ledgerExecutable[0]?.kind === "file_mutation"
        ? ledgerExecutable[0]
        : undefined;
      const nextMissingFileMutation = actionLedger ? undefined
        : guardEvidence.missingObligations[0]?.kind === "file_mutation"
          ? guardEvidence.missingObligations[0]
          : undefined;
      const nextFileMutationToolNames = nextLedgerMutation
        ? nextLedgerMutation.requiredToolNames.length > 0
          ? nextLedgerMutation.requiredToolNames
          : allowedNames.filter(name => nextLedgerMutation.operation === "edit"
            ? /^edit$/i.test(name)
            : /^(?:write|create)$/i.test(name))
        : nextMissingFileMutation?.requiredToolName
          ? allowedNames.filter(name => name.toLowerCase() === nextMissingFileMutation.requiredToolName?.toLowerCase())
          : actionLedger ? [] : allowedNames.filter(name => /^(?:write|edit)$/i.test(name));
      const retryInstruction = createToolRetryPrompt(allowedNames, {
        unavailableToolNames: toolCatalog.unavailableNames,
        failedToolNames: actionLedger ? [] : guardEvidence.failedToolNames,
        missingActionKinds: actionLedger
          ? ledgerExecutable.map(action => action.kind).filter((kind): kind is Exclude<typeof kind, "environment_inspection" | "tool_execution"> => (
              kind !== "environment_inspection" && kind !== "tool_execution"
            ))
          : guardEvidence.missingActionKinds,
        missingObligations: actionLedger
          ? ledgerExecutable.map(ledgerActionDescription)
          : guardEvidence.missingObligations.map(obligation => obligation.description),
        fulfilledObligations: actionLedger
          ? actionLedger.actions.filter(action => action.status === "succeeded").map(ledgerActionDescription)
          : fulfilledObligationDescriptions,
        staleObligations: actionLedger
          ? actionLedger.actions.filter(action => action.status === "stale").map(ledgerActionDescription)
          : guardEvidence.staleObligations.map(obligation => obligation.description),
        inconclusiveObligations: actionLedger ? [] : guardEvidence.inconclusiveObligations.map(obligation => obligation.description),
        cardinalityFailures: actionLedger ? [] : guardEvidence.cardinalityFailures,
        repeatedFailedToolName,
        rejectedToolName,
        malformedToolIntent,
        singleFileVerificationTarget: singleLedgerVerification?.target
          ?? singleMissingFileVerification?.argumentLiterals[0],
        singleFileVerificationToolName,
        nextFileMutationToolNames,
        nextLedgerAction: ledgerExecutable.length === 1
          ? ledgerActionDescription(ledgerExecutable[0]!)
          : undefined,
        nextLedgerToolNames: ledgerExecutable.length === 1
          ? ledgerActionToolNames(ledgerExecutable[0]!, allowedNames)
          : undefined,
        successfulEvidenceCallIds: actionLedger ? successfulLedgerCallIds(actionLedger) : undefined,
        failedEvidenceCallIds: actionLedger ? failedLedgerCallIds(actionLedger) : undefined,
        strictFinishRequired: Boolean(actionLedger && ledgerHasToolWorkflow(actionLedger)),
        planUpdateResult: strictTurn?.type === "plan_update"
          ? planUpdateDecision?.allowed
            ? { appliedRevision: planUpdateDecision.revision }
            : { rejectedReason: planUpdateDecision?.reason ?? "missing_action_ledger" }
          : undefined,
        planUpdateRequiredRevision: genericToolRuntimeMode === "enabled" && actionLedger
          && (actionLedger.plan.awaitingUpdate
            || initialExecutionPlanRequired(actionLedger))
          ? actionLedger.plan.revision
          : undefined,
        finishRejectedReason: strictTurn?.type === "finish" && finishDecision?.allowed !== true
          ? finishDecision?.reason
          : undefined,
        allRequirementsFulfilled: actionLedger
          ? ledgerComplete(actionLedger)
          : guardEvidence.obligations.length > 0 && guardEvidence.missingObligations.length === 0,
      });
      const retryPrompt = useLegacyFallbackPrompt
        ? this.buildPrompt(
            request,
            buildToolPromptFromCatalog(toolCatalog.text, { planUpdates: false }),
            actionLedger,
            "legacy",
          )
        : continueFromAppliedPlan
          ? this.buildPrompt(request, toolPrompt, actionLedger, genericToolRuntimeMode)
          : restartFromRejectedPlan
            ? [
                this.buildPrompt(request, toolPrompt, actionLedger, genericToolRuntimeMode),
                retryInstruction,
              ].filter(Boolean).join("\n\n")
          : attemptParentState === "repair_candidate"
            ? retryInstruction
            : [toolCatalog.text, retryInstruction].filter(Boolean).join("\n\n");
      logger.warn("completion_guard_retry", {
        stage: "guard",
        outcome: "retry",
        completion_attempt: completionAttempt,
        guard_attempt: retries,
        failure_class: "TOOL_CALL_REQUIRED",
        strict_turn_reason: strictTurnReason,
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
        callbacks.signal,
        retryBudget,
      );
      if (output.candidateMessageId !== null && output.candidateMessageId !== undefined) {
        attemptParent = output.candidateMessageId;
        attemptParentState = "repair_candidate";
      }
      const retryInspection = inspectStrictTurnFromOutput(output, toolCatalog.available);
      strictTurnReason = retryInspection.reason;
      strictTurn = retryInspection.turn;
      toolCall = retryInspection.toolCall;
      processedPlanUpdate = await processPlanUpdate(strictTurn, toolCall);
      planUpdateDecision = processedPlanUpdate.decision;
      toolCall = processedPlanUpdate.toolCall;
      if (!actionLedger && guardEvidence.isInformationalRequest) toolCall = null;
      malformedToolIntent = retryInspection.malformedToolIntent
        && (actionLedger ? true : !guardEvidence.isInformationalRequest);
      sawRepeatedFailedToolCall ||= isRepeatedFailedToolCall(toolCall, guardEvidence);
      ledgerAdmission = toolCall && actionLedger
        ? genericToolRuntimeMode === "enabled" && initialExecutionPlanRequired(actionLedger)
          ? { allowed: false, reason: "no_action" }
          : admitLedgerToolCall(actionLedger, toolCall)
        : undefined;
      finishDecision = actionLedger && strictTurn?.type === "finish"
        ? evaluateFinish(actionLedger, strictTurn)
        : undefined;
      rejectedToolName = toolCall && (actionLedger
        ? !ledgerAdmission?.allowed
        : !isRepeatedFailedToolCall(toolCall, guardEvidence)
          && !isToolCallSemanticallyAdmissible(toolCall, guardEvidence, allowedNames))
        ? toolCall.name
        : undefined;
      sawSemanticallyRejectedToolCall ||= rejectedToolName !== undefined;
      sawMalformedToolIntent ||= malformedToolIntent;
      if (toolCall) {
        output = { ...output, content: "", reasoning: "" };
      }
    }

    if (requiresRetry()) {
      logger.warn("completion_guard_rejected", {
        stage: "guard",
        outcome: "failure",
        completion_attempt: completionAttempt,
        guard_attempt: retries,
        latency_ms: Date.now() - startedAt,
        failure_class: "TOOL_CALL_REQUIRED",
        strict_turn_reason: strictTurnReason,
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
        missing_obligation_count: actionLedger ? outstandingLedgerActions(actionLedger).length : guardEvidence.missingObligations.length,
        stale_obligation_count: actionLedger ? actionLedger.actions.filter(action => action.status === "stale").length : guardEvidence.staleObligations.length,
        inconclusive_obligation_count: actionLedger ? 0 : guardEvidence.inconclusiveObligations.length,
        cardinality_failure_count: actionLedger ? 0 : guardEvidence.cardinalityFailures.length,
        missing_obligation_kinds: actionLedger
          ? outstandingLedgerActions(actionLedger).map(action => action.kind)
          : guardEvidence.missingActionKinds,
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
      content: toolCall ? "" : strictTurn?.type === "finish" ? strictTurn.text : output.content,
      toolCall: toolCall ? {
        name: toolCall.name,
        args: toolCall.arguments as Record<string, unknown>,
        actionId: ledgerAdmission?.actionId,
      } : undefined,
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
    signal?: AbortSignal,
    retryBudget?: UpstreamRetryBudget,
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
        signal,
        retryBudget,
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
    signal?: AbortSignal,
    retryBudget: UpstreamRetryBudget = this.upstreamController.createBudget(),
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
    return this.upstreamController.run(async (lease, upstreamAttempt) => {
      if (signal?.aborted) throw disconnectedError("challenge_headers");
      const challenge = await this.fetchChallenge(authGeneration, logger, signal, lease, upstreamAttempt);
      const solution = await this.options.solver.solve(challenge, logger);
      if (signal?.aborted) throw disconnectedError("completion_headers");
      return lease.request(async () => {
        const controller = new AbortController();
        const unlinkAbort = linkAbortSignal(controller, signal);
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
          retryAfterMs: retryAfterMs(res.headers),
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
          retryAfterMs: retryAfterMs(res.headers),
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
      primaryError = signal?.aborted ? disconnectedError(stage) : this.normalizeCompletionError(error, stage);
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
    unlinkAbort();

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
      }, upstreamAttempt);
    }, { logger, signal, budget: retryBudget });
  }

  private buildPrompt(
    request: CanonicalRequest,
    toolPrompt: string,
    actionLedger?: ActionLedger,
    genericToolRuntimeMode: GenericToolRuntimeMode = "legacy",
  ): string {
    const parts: string[] = [];
    if (request.system) parts.push(`System: ${request.system}`);
    if (toolPrompt) parts.push(toolPrompt);
    if (actionLedger && genericToolRuntimeMode === "enabled") {
      parts.push(executionPlanPrompt(actionLedger, genericToolRuntimeMode));
    }

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
            part.toolCall?.arguments ?? {},
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
    signal: AbortSignal | undefined,
    lease: UpstreamRequestLease,
    attempt: number,
  ): Promise<ReturnType<typeof parseChallengePayload> & { expireAt: number }> {
    const body = JSON.stringify({ target_path: COMPLETION_PATH });
    return lease.request(async () => {
      const controller = new AbortController();
      const unlinkAbort = linkAbortSignal(controller, signal);
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
            code: res.status === 429 ? "DEEPSEEK_RATE_LIMIT" : "UPSTREAM_ERROR",
            status: res.status === 429 ? 429 : 502,
            retryable: res.status === 429 || res.status >= 500,
            retryAfterMs: retryAfterMs(res.headers),
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
        attemptError = signal?.aborted
          ? disconnectedError(stage)
          : error instanceof BridgeError
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
      unlinkAbort();

      if (challenge) return challenge;
      logger.warn("upstream_challenge_failed", {
        stage,
        outcome: "failure",
        transport_attempt: attempt,
        ...failureFields(attemptError),
      });
      throw attemptError;
    }, attempt);
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

  private async createSessionOnce(
    authGeneration: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertAuthGeneration(authGeneration);
    const controller = new AbortController();
    const unlinkAbort = linkAbortSignal(controller, signal);
    let stage = "session_create_headers";
    const deadline = createRequestDeadline(this.options.timeoutMs, controller, () => stage);
    try {
      const res = await deadline.race(fetch(`${this.options.baseUrl}${SESSION_CREATE_PATH}`, {
        method: "POST",
        headers: this.buildHeaders(null, authGeneration),
        body: JSON.stringify({}),
        signal: controller.signal,
      }));
      this.assertAuthGeneration(authGeneration);
      if (res.status === 401 || res.status === 403) {
        throw new BridgeError(
          `DeepSeek authorization expired (HTTP ${res.status}). Use AUTH in Bridge Console, or run \`npm run auth\`.`,
          {
            code: res.status === 401 ? "DEEPSEEK_HTTP_401" : "DEEPSEEK_HTTP_403",
            status: res.status,
            upstreamStage: stage,
            causeCode: `http_${res.status}`,
          },
        );
      }
      if (!res.ok) {
        throw new BridgeError(`DeepSeek session creation HTTP ${res.status}`, {
          code: res.status === 429 ? "DEEPSEEK_RATE_LIMIT" : "UPSTREAM_ERROR",
          status: res.status === 429 ? 429 : 502,
          retryable: res.status === 429 || [502, 503, 504].includes(res.status),
          retryAfterMs: retryAfterMs(res.headers),
          upstreamStage: stage,
          causeCode: `http_${res.status}`,
        });
      }
      stage = "session_create_body";
      const json = await deadline.race(res.json()) as Record<string, unknown>;
      if (typeof json.code === "number" && json.code !== 0) {
        throw new BridgeError(`DeepSeek API error: ${json.code} ${json.msg ?? ""}`, {
          code: json.code === 40001 ? "DEEPSEEK_RATE_LIMIT" : "UPSTREAM_ERROR",
          status: json.code === 40001 ? 429 : 502,
          retryable: json.code === 40001,
          upstreamStage: stage,
          causeCode: json.code === 40001 ? "rate_limit_reached" : "api_error",
        });
      }
      const data = json.data;
      if (!data || typeof data !== "object") {
        throw new BridgeError("Session creation failed: missing data", {
          code: "UPSTREAM_ERROR",
          upstreamStage: stage,
          causeCode: "missing_data",
        });
      }
      const dataRecord = data as Record<string, unknown>;
      if (typeof dataRecord.biz_code === "number" && dataRecord.biz_code !== 0) {
        const rateLimited = dataRecord.biz_code === 40001;
        throw new BridgeError(`DeepSeek business error: ${dataRecord.biz_code} ${dataRecord.biz_msg ?? ""}`, {
          code: rateLimited ? "DEEPSEEK_RATE_LIMIT" : "UPSTREAM_ERROR",
          status: rateLimited ? 429 : 502,
          retryable: rateLimited,
          upstreamStage: stage,
          causeCode: rateLimited ? "rate_limit_reached" : "business_error",
        });
      }
      const bizData = dataRecord.biz_data && typeof dataRecord.biz_data === "object"
        ? dataRecord.biz_data as Record<string, unknown>
        : dataRecord;
      const session = bizData.chat_session && typeof bizData.chat_session === "object"
        ? bizData.chat_session as Record<string, unknown>
        : bizData;
      const id = session.id;
      if (typeof id !== "string" || !id) {
        throw new BridgeError("Session creation returned no id.", {
          code: "UPSTREAM_ERROR",
          upstreamStage: stage,
          causeCode: "missing_session_id",
        });
      }
      return id;
    } catch (error) {
      if (signal?.aborted) throw disconnectedError(stage);
      if (error instanceof BridgeError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw deadlineError(stage);
      throw new BridgeError("DeepSeek session creation failed.", {
        code: "UPSTREAM_ERROR",
        status: 502,
        retryable: true,
        upstreamStage: stage,
        causeCode: "transport_error",
      });
    } finally {
      deadline.clear();
      unlinkAbort();
    }
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

function linkAbortSignal(controller: AbortController, signal: AbortSignal | undefined): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function disconnectedError(stage: string): BridgeError {
  return new BridgeError("Downstream client disconnected.", {
    code: "CLIENT_DISCONNECTED",
    status: 499,
    retryable: false,
    upstreamStage: stage,
    causeCode: "downstream_disconnected",
  });
}

function retryAfterMs(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim();
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function ledgerHasToolWorkflow(ledger: ActionLedger): boolean {
  return ledger.unresolvedIntent || ledger.actions.length > 0 || ledger.callLedger.calls.length > 0;
}

function shouldRetryWithLedger(
  hasTools: boolean,
  toolCall: unknown,
  content: string,
  reasoning: string,
  allowedToolNames: string[],
  ledger: ActionLedger,
  admission: LedgerAdmission | undefined,
  malformedToolIntent: boolean,
  strictTurn: StrictBridgeTurn | null,
  finishDecision: FinishGuardDecision | undefined,
): boolean {
  if (!hasTools) return false;
  if (toolCall) return admission?.allowed !== true;
  if (strictTurn?.type === "plan_update") return true;
  if (strictTurn?.type === "finish") return finishDecision?.allowed !== true;
  if (malformedToolIntent) return true;
  if (ledgerHasToolWorkflow(ledger)) return true;
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
