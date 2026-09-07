export type CanonicalRole = "system" | "user" | "assistant" | "tool";

export type ToolCallKind = "function";

export interface CanonicalToolCall {
  id: string;
  type: ToolCallKind;
  name: string;
  arguments: Record<string, unknown>;
}

export interface CanonicalMessagePart {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  toolCall?: CanonicalToolCall;
  toolResult?: {
    toolUseId: string;
    content: string;
    isError?: boolean;
  };
}

export interface CanonicalMessage {
  role: CanonicalRole;
  parts: CanonicalMessagePart[];
}

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalRequest {
  model: string;
  stream: boolean;
  system: string;
  messages: CanonicalMessage[];
  tools: CanonicalTool[];
  sessionIdentity?: string;
  callId?: string;
  reasoning?: boolean;
  search?: boolean;
  maxTokens?: number;
}

export interface CanonicalChunk {
  type: "content" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  toolCall?: CanonicalToolCall;
  toolResult?: CanonicalMessagePart["toolResult"];
  done?: boolean;
}

export interface CanonicalResult {
  content: string;
  toolCalls: CanonicalToolCall[];
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  stopReason?: string;
}
