import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import type { CanonicalMessage, CanonicalRequest, CanonicalTool } from "./canonical.js";

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

function resolveText(items: unknown[] | string): string {
  if (typeof items === "string") return items;
  if (!Array.isArray(items)) return "";
  let text = "";
  for (const item of items) {
    if (typeof item === "string") {
      text += item;
    } else if (isRecord(item)) {
      if (item.type === "output_text" && typeof item.text === "string") text += item.text;
      if (item.type === "input_text" && typeof item.text === "string") text += item.text;
      if (typeof item.text === "string") text += item.text;
    }
  }
  return text;
}

function normalizeTools(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) return [];
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    const name = stringField(raw, "name", "");
    if (!name) continue;
    out.push({
      name,
      description: stringField(raw, "description", ""),
      inputSchema: isRecord(raw.parameters) ? raw.parameters : {},
    });
  }
  return out;
}

function normalizeMessages(input: unknown): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  if (!Array.isArray(input)) return out;
  for (const raw of input) {
    if (!isRecord(raw)) continue;
    const role = stringField(raw, "role", "user");
    const content = raw.content;
    if (role === "assistant") {
      const parts: CanonicalMessage["parts"] = [];
      const text = resolveText(Array.isArray(content) ? content : []);
      if (text) parts.push({ type: "text", text });
      if (Array.isArray(raw.output) || Array.isArray(raw.output_text)) {
        // Best-effort: assistant tool calls not standard for Responses here.
      }
      if (parts.length === 0) parts.push({ type: "text", text: "" });
      out.push({ role: "assistant", parts });
      continue;
    }
    if (role === "system") {
      out.push({ role: "system", parts: [{ type: "text", text: resolveText(Array.isArray(content) ? content : []) }] });
      continue;
    }
    const parts: CanonicalMessage["parts"] = [];
    if (Array.isArray(content)) {
      let text = "";
      for (const item of content) {
        if (isRecord(item) && item.type === "function_call") {
          const name = stringField(item, "name", "");
          const callId = stringField(item, "call_id", "");
          const args = isRecord(item.arguments) ? item.arguments : {};
          parts.push({
            type: "tool_use",
            toolCall: { id: callId, type: "function", name, arguments: args },
          });
          continue;
        }
        if (isRecord(item) && item.type === "function_call_output") {
          const callId = stringField(item, "call_id", "");
          const outputText = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
          parts.push({
            type: "tool_result",
            toolResult: { toolUseId: callId, content: outputText },
          });
          continue;
        }
        if (isRecord(item) && typeof item.text === "string") text += item.text;
        if (typeof item === "string") text += item;
      }
      if (text) parts.push({ type: "text", text });
    } else if (typeof content === "string") {
      parts.push({ type: "text", text: content });
    }
    out.push({ role: "user", parts });
  }
  return out;
}

export function normalizeResponses(body: unknown, headers: Record<string, string | undefined>): CanonicalRequest {
  const record = requireRecord(body);
  const instructions = stringField(record, "instructions", "");
  const out: CanonicalRequest = {
    model: stringField(record, "model", "deepseek-v4-flash"),
    stream: boolField(record, "stream", true),
    system: instructions,
    messages: [],
    tools: normalizeTools(record.tools),
    reasoning: optionalBoolField(record, "reasoning"),
    search: false,
    maxTokens: maxTokens(record),
  };
  const normalized = normalizeMessages(record.input);
  const systemParts = normalized
    .filter(m => m.role === "system")
    .map(m => m.parts.map(p => p.text ?? "").join(""))
    .join("\n\n");
  out.system = systemParts ? systemParts : instructions;
  out.messages = normalized.filter(m => m.role !== "system");
  return out;
}

function maxTokens(record: Record<string, unknown>): number | undefined {
  const value = record.max_output_tokens;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}
