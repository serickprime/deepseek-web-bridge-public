import type { CanonicalResult } from "../api/canonical.js";

export interface ResponsesOutputText {
  type: "output_text";
  text: string;
}

export interface ResponsesFunctionCall {
  type: "function_call";
  id: string;
  call_id: string;
  name: string;
  arguments: string;
}

export interface ResponsesResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  output: Array<ResponsesOutputText | ResponsesFunctionCall>;
  status: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export function toResponses(result: CanonicalResult, model: string): ResponsesResponse {
  const output: Array<ResponsesOutputText | ResponsesFunctionCall> = [];
  if (result.content) output.push({ type: "output_text", text: result.content });
  for (const call of result.toolCalls) {
    output.push({
      type: "function_call",
      id: call.id,
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    });
  }
  return {
    id: `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    output,
    status: result.toolCalls.length > 0 ? "incomplete" : "completed",
    usage: result.usage
      ? {
          input_tokens: result.usage.promptTokens ?? 0,
          output_tokens: result.usage.completionTokens ?? 0,
          total_tokens: result.usage.totalTokens ?? 0,
        }
      : undefined,
  };
}

export function responsesSseOutputText(delta: string): string {
  return `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    item_id: `msg_${Date.now().toString(36)}`,
    output_index: 0,
    content_index: 0,
    delta,
  })}\n\n`;
}

export function responsesSseDone(): string {
  return `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { id: `resp_${Date.now().toString(36)}`, status: "completed", output: [] },
  })}\n\n`;
}
