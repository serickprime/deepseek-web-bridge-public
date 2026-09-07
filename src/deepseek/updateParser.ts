import { isRecord } from "../utils/json.js";

const UINT32_MAX = 4_294_967_295;

function parseMessageId(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= UINT32_MAX) return value;
    return undefined;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n <= UINT32_MAX) return n;
    return undefined;
  }
  return undefined;
}

function parseAccumulatedTokenUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export interface UpdateChunk {
  index: number;
  delta: string;
  reasoningDelta?: string;
  messageId?: number;
  terminal: "success" | "incomplete" | null;
  parentMessageId?: number | null;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  accumulatedTokenUsage?: number;
}

/* ── DeepSeek Patch State Machine ── */

interface Fragment {
  type: string;
  content: string;
}

export class DeepSeekPatchParser {
  private currentPath: string | undefined;
  private currentOp = "SET";
  private fragments: Fragment[] = [];
  private status: string | undefined;
  private accumulatedTokenUsage: number | undefined;

  apply(raw: unknown): UpdateChunk | null {
    if (!isRecord(raw)) return null;

    // ── Old format: { data: { type: "...", message: {...} } } ──
    if ("data" in raw) return this.applyOldData(raw.data);

    if (!("v" in raw)) return null;
    const v = raw.v;

    // ── New p/o/v format — persist path/op across events ──
    if (typeof raw.p === "string") this.currentPath = raw.p;
    if (typeof raw.o === "string") this.currentOp = raw.o;

    let path = this.currentPath;
    let op = this.currentOp;

    // When p/o are nested inside v, extract the actual value
    let value: unknown = v;
    if (isRecord(v)) {
      if (typeof v.p === "string") { path = v.p; this.currentPath = v.p; }
      if (typeof v.o === "string") { op = v.o; this.currentOp = v.o; }
      if ("v" in v) value = v.v;
    }

    // Status update: { p: "response/status", o: "SET", v: "FINISHED" }
    if (path === "response/status" && typeof value === "string") {
      this.status = value;
      this.currentPath = undefined;
      this.currentOp = "SET";
      if (value === "FINISHED" || value === "INCOMPLETE") {
        return {
          index: 0,
          delta: "",
          terminal: value === "FINISHED" ? "success" : "incomplete",
          parentMessageId: null,
          accumulatedTokenUsage: this.accumulatedTokenUsage,
        };
      }
      return null;
    }

    // Initial snapshot: { v: { response: { fragments: [...], status: "..." } } }
    if (!path && isRecord(v)) {
      const response = v.response;
      if (isRecord(response)) return this.applyInitialSnapshot(response);
    }

    // BATCH: { v: [...] }
    if (op === "BATCH" && Array.isArray(value)) {
      return this.applyBatch(value);
    }

    // Fragment content append: explicit {p, o, v} or bare {v} continuation
    // via persisted currentPath/currentOp from previous APPEND event
    if (path === "response/fragments/-1/content" && op === "APPEND" && typeof value === "string") {
      if (value === "FINISHED" || value === "INCOMPLETE") return null;
      return this.applyFragmentAppend(value);
    }

    // New fragment append: { p: "response/fragments", o: "APPEND", v: [{type,content}] }
    if (path === "response/fragments" && op === "APPEND" && Array.isArray(value)) {
      return this.applyNewFragments(value);
    }

    // Plain token delta: { v: "text" } — only when no path context
    if (!path && typeof value === "string" && value !== "FINISHED" && value !== "INCOMPLETE") {
      return { index: 0, delta: value, terminal: null, parentMessageId: null };
    }

    return null;
  }

  private applyInitialSnapshot(response: Record<string, unknown>): UpdateChunk {
    if (typeof response.status === "string") this.status = response.status;
    const accumulatedTokenUsage = parseAccumulatedTokenUsage(response.accumulated_token_usage);
    if (accumulatedTokenUsage !== undefined) this.accumulatedTokenUsage = accumulatedTokenUsage;

    const fragArr = response.fragments;
    if (Array.isArray(fragArr)) {
      this.fragments = [];
      let delta = "";
      let reasoningDelta = "";
      for (const frag of fragArr) {
        if (!isRecord(frag) || typeof frag.type !== "string" || typeof frag.content !== "string") continue;
        this.fragments.push({ type: frag.type, content: frag.content });
        if (!frag.content) continue;
        if (frag.type === "THINK") reasoningDelta += frag.content;
        else delta += frag.content;
      }
      const messageId = parseMessageId(response.message_id);
      return {
        index: 0,
        delta,
        reasoningDelta: reasoningDelta || undefined,
        messageId,
        terminal: this.status === "FINISHED"
          ? "success"
          : this.status === "INCOMPLETE"
            ? "incomplete"
            : null,
        parentMessageId: null,
        accumulatedTokenUsage: this.accumulatedTokenUsage,
      };
    }

    return {
      index: 0,
      delta: "",
      terminal: this.status === "FINISHED"
        ? "success"
        : this.status === "INCOMPLETE"
          ? "incomplete"
          : null,
      parentMessageId: null,
      accumulatedTokenUsage: this.accumulatedTokenUsage,
    };
  }

  private applyBatch(arr: unknown[]): UpdateChunk | null {
    let delta = "";
    let reasoningDelta = "";
    let terminal: UpdateChunk["terminal"] = null;
    let messageId: number | undefined;
    let accumulatedTokenUsage: number | undefined;

    const savedPath = this.currentPath;
    const savedOp = this.currentOp;

    let subPath = "";
    let subOp = "SET";

    for (const item of arr) {
      if (!isRecord(item)) continue;
      if (typeof item.p === "string") subPath = item.p;
      if (typeof item.o === "string") subOp = item.o;

      const fullPath = savedPath ? (subPath || savedPath) : subPath;

      this.currentPath = fullPath;
      this.currentOp = subOp;

      if ("v" in item) {
        if (fullPath === "accumulated_token_usage" || fullPath === "response/accumulated_token_usage") {
          const parsed = parseAccumulatedTokenUsage(item.v);
          if (parsed !== undefined) {
            this.accumulatedTokenUsage = parsed;
            accumulatedTokenUsage = parsed;
          }
        }
        const child = this.apply({ p: fullPath, o: subOp, v: item.v });
        if (child) {
          delta += child.delta;
          if (child.reasoningDelta) reasoningDelta += child.reasoningDelta;
          if (child.terminal) terminal = child.terminal;
          if (child.messageId) messageId = child.messageId;
          if (terminal) break;
        }
      }
    }

    this.currentPath = savedPath;
    this.currentOp = savedOp;

    if (!delta && !reasoningDelta && !terminal && accumulatedTokenUsage === undefined) return null;

    return {
      index: 0,
      delta,
      reasoningDelta: reasoningDelta || undefined,
      messageId,
      terminal,
      parentMessageId: null,
      accumulatedTokenUsage: accumulatedTokenUsage ?? this.accumulatedTokenUsage,
    };
  }

  private applyFragmentAppend(text: string): UpdateChunk | null {
    const last = this.fragments[this.fragments.length - 1];
    if (!last) return null;

    last.content += text;

    if (last.type === "THINK") {
      return { index: 0, delta: "", reasoningDelta: text, terminal: null, parentMessageId: null };
    }
    return { index: 0, delta: text, terminal: null, parentMessageId: null };
  }

  private applyNewFragments(arr: unknown[]): UpdateChunk | null {
    let delta = "";
    let reasoningDelta = "";

    for (const item of arr) {
      if (!isRecord(item) || typeof item.type !== "string" || typeof item.content !== "string") continue;
      this.fragments.push({ type: item.type, content: item.content });
      if (!item.content) continue;
      if (item.type === "THINK") reasoningDelta += item.content;
      else delta += item.content;
    }

    if (!delta && !reasoningDelta) return null;

    return {
      index: 0,
      delta,
      reasoningDelta: reasoningDelta || undefined,
      terminal: null,
      parentMessageId: null,
    };
  }

  private applyOldData(data: unknown): UpdateChunk | null {
    if (!isRecord(data)) return null;
    const type = data.type;
    if (typeof type !== "string") return null;

    const message = isRecord(data.message) ? data.message : null;
    const index = typeof data.index === "number" ? data.index : 0;
    const terminal = type === "response_message_done" ? "success" : null;
    const messageId = parseMessageId(data.message_id);
    const reasoningDelta = typeof data.reasoning_content === "string" ? data.reasoning_content : undefined;

    let delta = "";
    let parentMessageId: number | null = null;
    if (message) {
      if (typeof message.content === "string") {
        delta = message.content;
      } else if (Array.isArray(message.content)) {
        delta = message.content
          .map((part: unknown) => {
            if (isRecord(part) && typeof part.text === "string") return part.text;
            if (typeof part === "string") return part;
            return "";
          })
          .join("");
      }
      const parent = parseMessageId(message.new_parent_message_id);
      if (parent !== undefined) parentMessageId = parent;
    }

    let usage: UpdateChunk["usage"];
    if (isRecord(data.usage)) {
      const u = data.usage;
      const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined;
      const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : undefined;
      const promptCache = typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : 0;
      const totalTokens =
        typeof u.total_tokens === "number" ? u.total_tokens
        : promptTokens !== undefined || completionTokens !== undefined
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : undefined;
      usage = {
        promptTokens: promptTokens !== undefined ? promptTokens + (promptCache ?? 0) : undefined,
        completionTokens,
        totalTokens,
      };
    }

    return {
      index,
      delta,
      reasoningDelta,
      messageId,
      terminal,
      parentMessageId: terminal ? parentMessageId : null,
      usage,
    };
  }

  getStatus(): string | undefined {
    return this.status;
  }

  getFragments(): Fragment[] {
    return this.fragments;
  }
}
