import type { CanonicalRequest, CanonicalResult, CanonicalToolCall } from "../api/canonical.js";
import { BridgeError } from "../utils/errors.js";
import { estimateTokenCount } from "../utils/tokenEstimate.js";

export type AnthropicErrorType =
  | "authentication_error"
  | "permission_error"
  | "rate_limit_error"
  | "timeout_error"
  | "conflict_error"
  | "request_too_large"
  | "invalid_request_error"
  | "api_error";

export interface AnthropicPublicError {
  type: AnthropicErrorType;
  message: string;
}

export interface AnthropicErrorResponse {
  type: "error";
  error: AnthropicPublicError;
}

export interface AnthropicContentBlock {
  type: "text" | "tool_use";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface AnthropicUsageResolution {
  source: "exact" | "estimated";
  usage: AnthropicMessageResponse["usage"];
}

function toBlock(call: CanonicalToolCall): AnthropicContentBlock {
  return { type: "tool_use", id: call.id, name: call.name, input: call.arguments };
}

function hasExactUsage(result: CanonicalResult): boolean {
  const promptTokens = result.usage?.promptTokens;
  const completionTokens = result.usage?.completionTokens;
  return Number.isSafeInteger(promptTokens)
    && Number.isSafeInteger(completionTokens)
    && (promptTokens ?? -1) >= 0
    && (completionTokens ?? -1) >= 0;
}

function estimateInputTokens(request: CanonicalRequest): number {
  return estimateTokenCount(JSON.stringify({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  }));
}

function estimateOutputTokens(content: AnthropicContentBlock[]): number {
  const visibleOutput = content
    .map(block => block.type === "text" ? (block.text ?? "") : JSON.stringify(block))
    .join("\n");
  return estimateTokenCount(visibleOutput);
}

export function resolveAnthropicUsage(
  request: CanonicalRequest,
  result: CanonicalResult,
  content: AnthropicContentBlock[],
): AnthropicUsageResolution {
  if (hasExactUsage(result)) {
    return {
      source: "exact",
      usage: {
        input_tokens: result.usage!.promptTokens!,
        output_tokens: result.usage!.completionTokens!,
      },
    };
  }
  return {
    source: "estimated",
    usage: {
      input_tokens: estimateInputTokens(request),
      output_tokens: estimateOutputTokens(content),
    },
  };
}

export function toAnthropicMessage(
  result: CanonicalResult,
  model: string,
  request: CanonicalRequest,
): AnthropicMessageResponse {
  const content: AnthropicContentBlock[] = [];
  if (result.content) content.push({ type: "text", text: result.content });
  for (const call of result.toolCalls) content.push(toBlock(call));
  const resolvedUsage = resolveAnthropicUsage(request, result, content);
  return {
    id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: result.toolCalls.length > 0 ? "tool_use" : (result.stopReason ?? "end_turn"),
    stop_sequence: null,
    usage: resolvedUsage.usage,
  };
}

export function anthropicSseMessageStart(model: string, index: number): string {
  return `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
    },
  })}\n\n`;
}

export function anthropicSseContentDelta(delta: string): string {
  return `event: content_block_delta\ndata: ${JSON.stringify({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: delta },
  })}\n\n`;
}

export function anthropicSseMessageDone(
  stopReason: "end_turn" | "tool_use" = "end_turn",
  usage?: CanonicalResult["usage"],
): string {
  const completionTokens = usage?.completionTokens;
  return `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(completionTokens !== undefined ? { usage: { output_tokens: completionTokens } } : {}),
  })}\n\n`;
}

export function anthropicSseStop(): string {
  return `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}

function publicMessage(error: BridgeError): string {
  switch (error.code) {
    case "INVALID_REQUEST":
    case "MODEL_UNAVAILABLE":
    case "REQUEST_TOO_LARGE":
      return error.message;
    case "AUTH_MISSING":
    case "AUTH_EXPIRED":
    case "DEEPSEEK_HTTP_401":
      return "Authentication failed";
    case "DEEPSEEK_HTTP_403":
      return "Permission denied";
    case "DEEPSEEK_RATE_LIMIT":
      return "Upstream rate limit exceeded";
    case "UPSTREAM_TIMEOUT":
      return "Upstream request timed out";
    case "SESSION_CONFLICT":
      return "Session conflict";
    case "PERSISTENCE_ERROR":
      return "Internal server error";
    default:
      return "Upstream request failed";
  }
}

export function toAnthropicPublicError(error: unknown): AnthropicPublicError {
  if (!(error instanceof BridgeError)) {
    return { type: "api_error", message: "Internal server error" };
  }
  let type: AnthropicErrorType;
  switch (error.code) {
    case "AUTH_MISSING":
    case "AUTH_EXPIRED":
    case "DEEPSEEK_HTTP_401":
      type = "authentication_error";
      break;
    case "DEEPSEEK_HTTP_403":
      type = "permission_error";
      break;
    case "DEEPSEEK_RATE_LIMIT":
      type = "rate_limit_error";
      break;
    case "UPSTREAM_TIMEOUT":
      type = "timeout_error";
      break;
    case "SESSION_CONFLICT":
      type = "conflict_error";
      break;
    case "REQUEST_TOO_LARGE":
      type = "request_too_large";
      break;
    case "INVALID_REQUEST":
    case "MODEL_UNAVAILABLE":
      type = "invalid_request_error";
      break;
    default:
      type = "api_error";
  }
  return { type, message: publicMessage(error) };
}

export function anthropicErrorResponse(error: AnthropicPublicError): AnthropicErrorResponse {
  return { type: "error", error };
}

export function anthropicSseError(error: AnthropicPublicError): string {
  return `event: error\ndata: ${JSON.stringify(anthropicErrorResponse(error))}\n\n`;
}
