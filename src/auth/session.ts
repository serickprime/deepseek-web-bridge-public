import crypto from "node:crypto";
import { SESSION_ID_ENTROPY_BYTES } from "../config/constants.js";

export interface AuthSession {
  sessionId: string;
  sidCookie: string;
  createdAt: number;
  updatedAt: number;
  name?: string;
}

export type SessionMap = Record<string, AuthSession>;

export function generateSessionId(): string {
  return crypto.randomBytes(SESSION_ID_ENTROPY_BYTES).toString("hex");
}

export function createSession(sidCookie: string, name?: string): AuthSession {
  const now = Date.now();
  return {
    sessionId: generateSessionId(),
    sidCookie,
    createdAt: now,
    updatedAt: now,
    name,
  };
}

export function isExpired(session: AuthSession, ttlMs: number, now = Date.now()): boolean {
  return now - session.updatedAt > ttlMs;
}

export function sessionsToMap(sessions: AuthSession[]): SessionMap {
  const map: SessionMap = {};
  for (const session of sessions) map[session.sessionId] = session;
  return map;
}
