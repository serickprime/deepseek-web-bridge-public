import type { AuthSession } from "../auth/session.js";
import { BridgeError } from "../utils/errors.js";
import { isRecord } from "../utils/json.js";
import {
  readJsonStrictIfExists,
  writeJsonAtomic,
  type StrictJsonReadResult,
} from "../utils/atomicFile.js";

export interface PersistentSessionLink {
  callId: string;
  upstreamKey: string;
  createdAt: number;
}

interface SessionDocumentSnapshot {
  siblings: Record<string, unknown>;
  sessions: AuthSession[];
  links: PersistentSessionLink[];
}

interface PersistentSessionDocumentOptions {
  read?: (file: string) => Promise<StrictJsonReadResult>;
  write?: (file: string, data: unknown, mode?: number) => Promise<void>;
}

const CURRENT_VERSION = 2;
const SUPPORTED_VERSIONS = new Set([1, CURRENT_VERSION]);

function persistenceError(message: string): BridgeError {
  return new BridgeError(message, { code: "PERSISTENCE_ERROR", status: 500 });
}

function isAuthSession(value: unknown): value is AuthSession {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.sidCookie === "string" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.name === undefined || typeof value.name === "string")
  );
}

function isSessionLink(value: unknown): value is PersistentSessionLink {
  return (
    isRecord(value) &&
    typeof value.callId === "string" &&
    typeof value.upstreamKey === "string" &&
    typeof value.createdAt === "number"
  );
}

function cloneSessions(sessions: AuthSession[]): AuthSession[] {
  return sessions.map(session => ({ ...session }));
}

function cloneLinks(links: PersistentSessionLink[]): PersistentSessionLink[] {
  return links.map(link => ({ ...link }));
}

function emptySnapshot(): SessionDocumentSnapshot {
  return { siblings: Object.create(null) as Record<string, unknown>, sessions: [], links: [] };
}

function normalizeArray<T extends object>(
  value: unknown,
  field: "sessions" | "links",
  validator: (item: unknown) => item is T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !validator(item))) {
    throw persistenceError(`Persistent session document has an invalid ${field} field.`);
  }
  return value.map(item => ({ ...item }));
}

function normalizeDocument(value: unknown): SessionDocumentSnapshot {
  if (!isRecord(value)) {
    throw persistenceError("Persistent session document root must be an object.");
  }
  if (typeof value.version !== "number" || !SUPPORTED_VERSIONS.has(value.version)) {
    throw persistenceError("Persistent session document version is not supported.");
  }
  if (value.version === CURRENT_VERSION &&
      (!Array.isArray(value.sessions) || !Array.isArray(value.links))) {
    throw persistenceError("Persistent session document v2 requires sessions and links arrays.");
  }

  const siblings: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (key !== "version" && key !== "sessions" && key !== "links") {
      siblings[key] = structuredClone(item);
    }
  }
  return {
    siblings,
    sessions: normalizeArray(value.sessions, "sessions", isAuthSession),
    links: normalizeArray(value.links, "links", isSessionLink),
  };
}

export class PersistentSessionDocument {
  private snapshot = emptySnapshot();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly readFile: (file: string) => Promise<StrictJsonReadResult>;
  private readonly writeFile: (file: string, data: unknown, mode?: number) => Promise<void>;

  constructor(
    private readonly file: string,
    options: PersistentSessionDocumentOptions = {},
  ) {
    this.readFile = options.read ?? readJsonStrictIfExists;
    this.writeFile = options.write ?? writeJsonAtomic;
  }

  init(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.load();
    return this.initPromise;
  }

  getSessions(): AuthSession[] {
    this.assertInitialized();
    return cloneSessions(this.snapshot.sessions);
  }

  getLinks(): PersistentSessionLink[] {
    this.assertInitialized();
    return cloneLinks(this.snapshot.links);
  }

  replaceSessions(sessions: AuthSession[]): Promise<void> {
    const nextSessions = cloneSessions(sessions);
    return this.enqueue(snapshot => ({ ...snapshot, sessions: nextSessions }));
  }

  replaceLinks(links: PersistentSessionLink[]): Promise<void> {
    const nextLinks = cloneLinks(links);
    return this.enqueue(snapshot => ({ ...snapshot, links: nextLinks }));
  }

  private async load(): Promise<void> {
    if (this.file === ":memory:") {
      this.initialized = true;
      return;
    }
    try {
      const loaded = await this.readFile(this.file);
      this.snapshot = loaded.exists ? normalizeDocument(loaded.value) : emptySnapshot();
      this.initialized = true;
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw persistenceError(
        error instanceof SyntaxError
          ? "Persistent session document contains invalid JSON."
          : "Persistent session document could not be loaded.",
      );
    }
  }

  private enqueue(
    mutation: (snapshot: SessionDocumentSnapshot) => SessionDocumentSnapshot,
  ): Promise<void> {
    this.assertInitialized();
    const operation = this.writeTail.then(async () => {
      const next = mutation({
        siblings: structuredClone(this.snapshot.siblings),
        sessions: cloneSessions(this.snapshot.sessions),
        links: cloneLinks(this.snapshot.links),
      });
      if (this.file !== ":memory:") {
        const payload = {
          ...next.siblings,
          version: CURRENT_VERSION,
          sessions: cloneSessions(next.sessions),
          links: cloneLinks(next.links),
        };
        try {
          await this.writeFile(this.file, payload, 0o600);
        } catch {
          throw persistenceError("Persistent session document could not be committed.");
        }
      }
      this.snapshot = next;
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw persistenceError("Persistent session document is not initialized.");
    }
  }
}
