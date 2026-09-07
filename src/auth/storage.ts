import type { PersistentSessionDocument } from "../sessions/persistentSessionDocument.js";
import type { AuthSession, SessionMap } from "./session.js";

export interface SessionStorage {
  load(): Promise<SessionMap>;
  save(map: SessionMap): Promise<void>;
}

function sessionsToMap(sessions: AuthSession[]): SessionMap {
  const map: SessionMap = {};
  for (const session of sessions) {
    map[session.sessionId] = session;
  }
  return map;
}

export class FileSessionStorage implements SessionStorage {
  constructor(private readonly document: PersistentSessionDocument) {}

  async load(): Promise<SessionMap> {
    return sessionsToMap(this.document.getSessions());
  }

  async save(map: SessionMap): Promise<void> {
    await this.document.replaceSessions(Object.values(map));
  }
}
