import { randomToken } from "../utils/crypto.js";
import { SESSION_LINK_TTL_MS } from "../config/constants.js";
import {
  type PersistentSessionLink,
  PersistentSessionDocument,
} from "./persistentSessionDocument.js";

export type SessionLink = PersistentSessionLink;

export class LineageStore {
  private links = new Map<string, SessionLink>();
  private cleanupPending = false;

  constructor(private readonly document: PersistentSessionDocument) {}

  async init(): Promise<void> {
    this.links.clear();
    for (const item of this.document.getLinks()) this.links.set(item.callId, item);
    this.cleanupPending = false;
    const previous = new Map(this.links);
    if (!this.pruneExpired(Date.now())) return;
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      this.cleanupPending = false;
      throw error;
    }
  }

  getUpstreamKey(callId: string): string | undefined {
    const link = this.links.get(callId);
    if (!link) return undefined;
    if (this.isExpired(link, Date.now())) {
      this.links.delete(callId);
      this.cleanupPending = true;
      return undefined;
    }
    return link.upstreamKey;
  }

  async record(callId: string, upstreamKey: string): Promise<void> {
    const previous = new Map(this.links);
    const previousCleanupPending = this.cleanupPending;
    const now = Date.now();
    this.pruneExpired(now);
    this.links.set(callId, { callId, upstreamKey, createdAt: now });
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      this.cleanupPending = previousCleanupPending;
      throw error;
    }
  }

  async removeByUpstreamKey(upstreamKey: string): Promise<void> {
    const previous = new Map(this.links);
    const previousCleanupPending = this.cleanupPending;
    this.pruneExpired(Date.now());
    let removed = false;
    for (const [callId, link] of this.links) {
      if (link.upstreamKey === upstreamKey) {
        this.links.delete(callId);
        removed = true;
      }
    }
    if (!removed && !this.cleanupPending) return;
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      this.cleanupPending = previousCleanupPending;
      throw error;
    }
  }

  async clear(): Promise<void> {
    const previous = new Map(this.links);
    const previousCleanupPending = this.cleanupPending;
    this.links.clear();
    try {
      await this.persist();
    } catch (error) {
      this.links = previous;
      this.cleanupPending = previousCleanupPending;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    await this.document.replaceLinks([...this.links.values()]);
    this.cleanupPending = false;
  }

  private pruneExpired(now: number): boolean {
    let pruned = false;
    for (const [callId, link] of this.links) {
      if (!this.isExpired(link, now)) continue;
      this.links.delete(callId);
      pruned = true;
    }
    if (pruned) this.cleanupPending = true;
    return pruned;
  }

  private isExpired(link: SessionLink, now: number): boolean {
    return now - link.createdAt > SESSION_LINK_TTL_MS;
  }
}

export function generateUpstreamKey(): string {
  return randomToken(16);
}
