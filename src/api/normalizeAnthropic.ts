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

function normalizeSystem(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    throw new BridgeError("Anthropic system must be a string or an array of text blocks.", {
      code: "INVALID_REQUEST",
      status: 400,
    });
  }

  const blocks: string[] = [];
  for (const block of value) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new BridgeError("Anthropic system blocks must have type text and string text.", {
        code: "INVALID_REQUEST",
        status: 400,
      });
    }
    blocks.push(block.text);
  }
  return blocks.join("\n");
}

function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === "boolean" ? value : fallback;
}

function isBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

function blockToString(block: Record<string, unknown>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  return "";
}

function normalizeTools(tools: unknown): CanonicalTool[] {
  if (!Array.isArray(tools)) return [];
  const out: CanonicalTool[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) continue;
    if (raw.type === "function" && isRecord(raw.function)) {
      const fn = raw.function;
      const name = stringField(fn, "name", "");
      if (!name) continue;
      out.push({
        name,
        description: stringField(fn, "description", ""),
        inputSchema: isRecord(fn.input_schema) ? fn.input_schema : {},
      });
      continue;
    }
    const name = stringField(raw, "name", "");
    if (!name) continue;
    out.push({ name, description: stringField(raw, "description", ""), inputSchema: isRecord(raw.input_schema) ? raw.input_schema : {} });
  }
  return out;
}

function normalizeContent(content: unknown): CanonicalMessage["parts"] {
  const parts: CanonicalMessage["parts"] = [];
  if (typeof content === "string") {
    parts.push({ type: "text", text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const raw of content) {
    if (!isBlock(raw)) continue;
    const type = raw.type ?? "text";
    if (type === "text" || type === "text_delta") {
      const text = blockToString(raw);
      if (text) parts.push({ type: "text", text });
    } else if (type === "thinking") {
      const text = typeof raw.thinking === "string" ? raw.thinking : "";
      if (text) parts.push({ type: "thinking", text });
    } else if (type === "tool_use") {
      const name = stringField(raw, "name", "");
      if (name) {
        parts.push({
          type: "tool_use",
          toolCall: {
            id: stringField(raw, "id", ""),
            type: "function",
            name,
            arguments: isRecord(raw.input) ? raw.input : {},
          },
        });
      }
    } else if (type === "tool_result") {
      const toolUseId = stringField(raw, "tool_use_id", "");
      const innerContent = typeof raw.content === "string" ? raw.content : "";
      const joined = typeof raw.content === "string"
        ? innerContent
        : Array.isArray(raw.content)
          ? raw.content.map(part => isBlock(part) ? blockToString(part) : "").join("\n")
          : "";
      parts.push({
        type: "tool_result",
        toolResult: { toolUseId, content: joined, isError: boolField(raw, "is_error", false) },
      });
    }
  }
  return parts;
}

function normalizeMessages(messages: unknown[], system: string): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  if (system) out.push({ role: "system", parts: [{ type: "text", text: system }] });
  if (!Array.isArray(messages)) return out;
  for (const raw of messages) {
    if (!isRecord(raw)) continue;
    const role = stringField(raw, "role", "user");
    if (role === "system") {
      out.push({ role: "system", parts: normalizeContent(raw.content) });
      continue;
    }
    out.push({ role: role === "assistant" ? "assistant" : "user", parts: normalizeContent(raw.content) });
  }
  return out;
}

export function normalizeAnthropic(body: unknown, headers: Record<string, string | undefined>): CanonicalRequest {
  const record = requireRecord(body);
  const system = normalizeSystem(record.system);
  const thinking = record.thinking;
  const reasoning = isRecord(thinking) && typeof thinking.type === "string"
    ? thinking.type === "enabled"
    : undefined;
  const out: CanonicalRequest = {
    model: stringField(record, "model", "deepseek-v4-flash"),
    stream: boolField(record, "stream", false),
    system,
    messages: normalizeMessages(Array.isArray(record.messages) ? record.messages : [], ""),
    tools: normalizeTools(record.tools),
    reasoning,
    search: false,
    maxTokens: maxTokens(record),
  };
  return out;
}

function maxTokens(record: Record<string, unknown>): number | undefined {
  const value = record.max_tokens;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return undefined;
}
