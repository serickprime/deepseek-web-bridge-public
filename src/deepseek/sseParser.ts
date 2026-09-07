import { isRecord } from "../utils/json.js";

export type SseEventType = "text" | "reasoning" | "done" | "update" | "hint" | "other";

export interface SseEvent {
  type: SseEventType;
  data: unknown;
  jsonParseFailed: boolean;
}

export interface SseParserOptions {
  onEvent?: (event: SseEvent) => void;
  onError?: (message: string) => void;
}

export function isDeepSeekRateLimitHint(event: SseEvent): boolean {
  return event.type === "hint"
    && isRecord(event.data)
    && event.data.finish_reason === "rate_limit_reached";
}

export function splitSseStream(chunk: Buffer | string): { events: string[]; rest: string } {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  const lines = text.split(/\r?\n/);
  const events: string[] = [];
  let buffer: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (buffer.length > 0) {
        events.push(buffer.join("\n"));
        buffer = [];
      }
    } else if (line.startsWith(":")) {
      // comment, ignore
    } else {
      buffer.push(line);
    }
  }
  return { events, rest: buffer.join("\n") };
}

export class SseAccumulator {
  private buffer = "";

  push(chunk: Buffer | string): SseEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const parts = splitSseStream(this.buffer);
    this.buffer = parts.rest;
    const events: SseEvent[] = [];
    for (const raw of parts.events) {
      const parsed = parseSseBlock(raw);
      if (parsed) events.push(parsed);
    }
    return events;
  }

  flush(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer.trim()) {
      const parsed = parseSseBlock(this.buffer);
      if (parsed) events.push(parsed);
    }
    this.buffer = "";
    return events;
  }
}

export function parseSseBlock(block: string): SseEvent | null {
  let eventField = "";
  let dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      eventField = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trim());
    }
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join("\n");
  let data: unknown = dataText;
  let jsonParseFailed = false;
  try {
    data = JSON.parse(dataText);
  } catch {
    // keep raw string
    jsonParseFailed = true;
  }
  const type: SseEventType = eventField === "message" ? "text"
    : eventField === "reasoning" ? "reasoning"
    : eventField === "done" ? "done"
    : eventField === "update" ? "update"
    : eventField === "hint" ? "hint"
    : eventField === "" ? "update"
    : "other";
  return { type, data, jsonParseFailed };
}
