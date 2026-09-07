import { SESSION_MAX_ENTRIES, SESSION_TTL_MS } from "../config/constants.js";
import type { Logger } from "../utils/logger.js";
import {
  createSession,
  isExpired,
  type AuthSession,
  type SessionMap,
} from "./session.js";
import type { SessionStorage } from "./storage.js";

export interface SessionManagerOptions {
  ttlMs?: number;
  maxEntries?: number;
  logger?: Logger;
}

export class SessionManager {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly logger?: Logger;
  private sessions: SessionMap = {};

  constructor(
    private readonly storage: SessionStorage,
    options: SessionManagerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
    this.maxEntries = options.maxEntries ?? SESSION_MAX_ENTRIES;
    this.logger = options.logger;
  }

  async init(): Promise<void> {
    this.sessions = await this.storage.load();
    await this.purgeExpired();
  }

  getSession(sessionId: string): AuthSession | null {
    const session = this.sessions[sessionId];
    if (!session) return null;
    if (isExpired(session, this.ttlMs)) {
      delete this.sessions[sessionId];
      void this.persist().catch(() => {
        if (!(sessionId in this.sessions)) this.sessions[sessionId] = session;
      });
      return null;
    }
    return session;
  }

  listSessions(): AuthSession[] {
    return Object.values(this.sessions);
  }

  async addSession(sidCookie: string, name?: string): Promise<AuthSession> {
    await this.purgeExpired();
    if (Object.keys(this.sessions).length >= this.maxEntries) {
      throw new Error(`Session store is full (max ${this.maxEntries} sessions).`);
    }
    const session = createSession(sidCookie, name);
    this.sessions[session.sessionId] = session;
    try {
      await this.persist();
    } catch (error) {
      delete this.sessions[session.sessionId];
      throw error;
    }
    this.logger?.info("session_created", {
      session_id: session.sessionId,
      name: session.name,
      count: Object.keys(this.sessions).length,
    });
    return session;
  }

  async removeSession(sessionId: string): Promise<boolean> {
    const removed = this.sessions[sessionId];
    if (!removed) return false;
    delete this.sessions[sessionId];
    try {
      await this.persist();
    } catch (error) {
      this.sessions[sessionId] = removed;
      throw error;
    }
    this.logger?.info("session_removed", {
      session_id: sessionId,
      count: Object.keys(this.sessions).length,
    });
    return true;
  }

  async purgeExpired(): Promise<number> {
    const now = Date.now();
    const expired: string[] = [];
    for (const [id, session] of Object.entries(this.sessions)) {
      if (isExpired(session, this.ttlMs, now)) expired.push(id);
    }
    const removed = expired.map(id => this.sessions[id]).filter((session): session is AuthSession => Boolean(session));
    for (const id of expired) delete this.sessions[id];
    if (expired.length > 0) {
      try {
        await this.persist();
      } catch (error) {
        for (const session of removed) this.sessions[session.sessionId] = session;
        throw error;
      }
      this.logger?.info("sessions_purged", { count: expired.length });
    }
    return expired.length;
  }

  async touch(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    const previousUpdatedAt = session.updatedAt;
    session.updatedAt = Date.now();
    try {
      await this.persist();
    } catch (error) {
      session.updatedAt = previousUpdatedAt;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.save(this.sessions);
    } catch (error) {
      this.logger?.error("session_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
