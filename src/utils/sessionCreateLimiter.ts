import { SESSION_CREATE_INTERVAL_MS } from "../config/constants.js";

export class SessionCreateLimiter {
  private lastCreatedAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly intervalMs = SESSION_CREATE_INTERVAL_MS) {}

  async acquire(): Promise<void> {
    const prev = this.tail;
    let release: () => void;
    this.tail = new Promise<void>(r => { release = r; });
    await prev;
    const elapsed = Date.now() - this.lastCreatedAt;
    if (elapsed < this.intervalMs) {
      await new Promise(r => setTimeout(r, this.intervalMs - elapsed));
    }
    this.lastCreatedAt = Date.now();
    release!();
  }
}
