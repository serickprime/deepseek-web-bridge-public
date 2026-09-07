import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "./canonical.js";

export interface ProtocolInput {
  protocol: "openai" | "anthropic" | "responses";
  body: unknown;
  headers: Record<string, string | undefined>;
}

function requireRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new BridgeError("Request body must be a JSON object.", { code: "INVALID_REQUEST" });
  }
  return body;
}

function stringField(body: Record<string, unknown>, key: string, fallback: string): string {
  const value = body[key];
  return typeof value === "string" ? value : fallback;
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function optionalBoolField(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function maxTokensField(body: Record<string, unknown>): number | undefined {
  const value = body.max_tokens ?? body.max_output_tokens;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}

function normalizeOpenAITools(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) return [];
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    const fn = isRecord(raw.function) ? raw.function : raw;
    const name = stringField(fn, "name", "") || stringField(raw, "name", "");
    if (!name) continue;
    const inputSchema = isRecord(fn.parameters) ? fn.parameters : isRecord(raw.parameters) ? raw.parameters : {};
    out.push({ name, description: stringField(fn, "description", "") || stringField(raw, "description", ""), inputSchema });
  }
  return out;
}

function openAIContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "image_url") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function normalizeOpenAIMessages(messages: unknown[]): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = stringField(raw, "role", "user");
    if (role === "system") {
      out.push({ role: "system", parts: [{ type: "text", text: openAIContentToString(raw.content) }] });
      continue;
    }
    if (role === "tool") {
      out.push({
        role: "tool",
        parts: [
          {
            type: "tool_result",
            toolResult: {
              toolUseId: stringField(raw, "tool_call_id", ""),
              content: openAIContentToString(raw.content),
              isError: boolField(raw, "is_error", false),
            },
          },
        ],
      });
      continue;
    }
    if (role === "assistant") {
      const parts: CanonicalMessage["parts"] = [];
      const content = openAIContentToString(raw.content);
      if (content) parts.push({ type: "text", text: content });
      if (Array.isArray(raw.tool_calls)) {
        for (const tc of raw.tool_calls) {
          if (!isRecord(tc)) continue;
          const fn = isRecord(tc.function) ? tc.function : {};
          let parsedArgs: Record<string, unknown> = {};
          const argsRaw = stringField(fn, "arguments", "{}");
          try {
            const parsed = JSON.parse(argsRaw);
            if (isRecord(parsed)) parsedArgs = parsed;
          } catch {
            parsedArgs = {};
          }
          parts.push({
            type: "tool_use",
            toolCall: {
              id: stringField(tc, "id", ""),
              type: "function",
              name: stringField(fn, "name", ""),
              arguments: parsedArgs,
            },
          });
        }
      }
      out.push({ role: "assistant", parts });
      continue;
    }
    out.push({ role: "user", parts: [{ type: "text", text: openAIContentToString(raw.content) }] });
  }
  return out;
}

export function normalizeOpenAI(body: unknown, headers: Record<string, string | undefined>): CanonicalRequest {
  const record = requireRecord(body);
  const messages = Array.isArray(record.messages) ? record.messages : [];
  const out: CanonicalRequest = {
    model: stringField(record, "model", "deepseek-v4-flash"),
    stream: boolField(record, "stream", true),
    system: "",
    messages: [],
    tools: normalizeOpenAITools(record.tools),
    reasoning: optionalBoolField(record, "reasoning"),
    search: boolField(record, "search", false),
    maxTokens: maxTokensField(record),
  };
  const normalized = normalizeOpenAIMessages(messages);
  const systemParts = normalized
    .filter(m => m.role === "system")
    .map(m => m.parts.map(p => p.text ?? "").join(""))
    .join("\n\n");
  out.system = systemParts;
  out.messages = normalized.filter(m => m.role !== "system");
  return out;
}
