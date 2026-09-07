import { SESSION_MAX_CHARS, SESSION_MAX_ENTRIES } from "../config/constants.js";

export interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  messageId?: number;
}

export interface UpstreamSessionState {
  chatSessionId: string | null;
  parentMessageId: number | null;
  history: ChatEntry[];
  updatedAt: number;
}

export class SessionStore {
  private readonly states = new Map<string, UpstreamSessionState>();
  private readonly maxEntries: number;
  private readonly maxChars: number;

  constructor(maxEntries = SESSION_MAX_ENTRIES, maxChars = SESSION_MAX_CHARS) {
    this.maxEntries = maxEntries;
    this.maxChars = maxChars;
  }

  getOrCreate(key: string): UpstreamSessionState {
    let state = this.states.get(key);
    if (!state) {
      state = { chatSessionId: null, parentMessageId: null, history: [], updatedAt: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  get(key: string): UpstreamSessionState | undefined {
    return this.states.get(key);
  }

  touch(state: UpstreamSessionState): void {
    state.updatedAt = Date.now();
  }

  reset(key: string): void {
    this.states.delete(key);
  }

  clear(): void {
    this.states.clear();
  }

  appendHistory(state: UpstreamSessionState, entry: ChatEntry): void {
    state.history.push(entry);
    this.enforceLimits(state);
  }

  private enforceLimits(state: UpstreamSessionState): void {
    if (state.history.length > this.maxEntries) {
      state.history.splice(0, state.history.length - this.maxEntries);
    }
    let total = 0;
    let cut = 0;
    for (let i = 0; i < state.history.length; i++) {
      const entry = state.history[i];
      if (!entry) continue;
      total += entry.content.length;
      if (total > this.maxChars) {
        cut = i + 1;
        break;
      }
    }
    if (cut > 0) {
      state.history.splice(0, cut);
      if (state.history.length === 0 && total > this.maxChars) {
        const last = state.history[0];
        if (last) state.history.push({ role: last.role, content: last.content.slice(-this.maxChars) });
      }
    }
  }

  prune(maxAgeMs: number): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, state] of this.states) {
      if (now - state.updatedAt > maxAgeMs) {
        this.states.delete(key);
        removed++;
      }
    }
    return removed;
  }
}
