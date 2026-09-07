export type BridgeErrorCode =
  | "AUTH_MISSING"
  | "AUTH_EXPIRED"
  | "DEEPSEEK_HTTP_401"
  | "DEEPSEEK_HTTP_403"
  | "DEEPSEEK_RATE_LIMIT"
  | "POW_CHALLENGE_FAILED"
  | "POW_FORMAT_CHANGED"
  | "WASM_DOWNLOAD_FAILED"
  | "WASM_COMPILE_FAILED"
  | "UPSTREAM_TIMEOUT"
  | "STREAM_INCOMPLETE"
  | "STREAM_PARSE_FAILED"
  | "MODEL_UNAVAILABLE"
  | "TOOL_PARSE_FAILED"
  | "TOOL_CALL_REQUIRED"
  | "SESSION_CONFLICT"
  | "PERSISTENCE_ERROR"
  | "UPSTREAM_ERROR"
  | "INVALID_REQUEST"
  | "REQUEST_TOO_LARGE"
  | "SHUTDOWN_INCOMPLETE";

export interface BridgeErrorOptions {
  code: BridgeErrorCode;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number | null;
  upstreamStage?: string | null;
  causeCode?: string | null;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly upstreamStage: string | null;
  readonly causeCode: string | null;

  constructor(message: string, options: BridgeErrorOptions) {
    super(message);
    this.name = "BridgeError";
    this.code = options.code;
    this.status = options.status ?? (options.retryable ? 502 : 400);
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.upstreamStage = options.upstreamStage ?? null;
    this.causeCode = options.causeCode ?? null;
  }
}

export function httpStatusForCode(code: BridgeErrorCode): number {
  switch (code) {
    case "AUTH_MISSING":
    case "AUTH_EXPIRED":
    case "DEEPSEEK_HTTP_401":
      return 401;
    case "DEEPSEEK_HTTP_403":
      return 403;
    case "DEEPSEEK_RATE_LIMIT":
      return 429;
    case "INVALID_REQUEST":
      return 400;
    case "REQUEST_TOO_LARGE":
      return 413;
    case "UPSTREAM_TIMEOUT":
      return 504;
    default:
      return 502;
  }
}

export function safeErrorMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message || "Unknown error";
  return "Unknown error";
}
