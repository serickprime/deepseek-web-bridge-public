import type { CanonicalResult } from "../api/canonical.js";

export interface OpenAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function toOpenAIChat(result: CanonicalResult, model: string): OpenAIChatResponse {
  const message: OpenAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: result.content || null,
  };
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((call, index) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    }));
  }
  return {
    id: `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: result.stopReason ?? "stop" }],
    usage: result.usage
      ? {
          prompt_tokens: result.usage.promptTokens ?? 0,
          completion_tokens: result.usage.completionTokens ?? 0,
          total_tokens: result.usage.totalTokens ?? 0,
        }
      : undefined,
  };
}

export function openaiSseChunk(index: number, delta: string): string {
  const payload = {
    id: `chatcmpl-${Date.now().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "",
    choices: [{ index, delta: { content: delta }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function openaiSseDone(index: number): string {
  return `data: [DONE]\n\n`;
}
