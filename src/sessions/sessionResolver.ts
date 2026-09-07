export interface RequestIdentity {
  clientSessionId?: string;
  upstreamIdentity?: string;
  callId?: string;
}

const CLIENT_IDENTITY_HEADERS = [
  "x-claude-code-session-id",
  "x-agent-session",
  "x-session-id",
  "x-call-id",
];

export function resolveClientIdentity(headers: Record<string, string | undefined>): string {
  for (const name of CLIENT_IDENTITY_HEADERS) {
    const value = headers[name];
    if (value && typeof value === "string") {
      return value.slice(0, 128);
    }
  }
  return "anonymous";
}

export function resolveUpstreamIdentity(body: Record<string, unknown>): string | undefined {
  const metadata = body.metadata;
  if (metadata && typeof metadata === "object") {
    const userId = (metadata as Record<string, unknown>).user_id;
    if (typeof userId === "string" && userId.length > 0 && userId.length <= 128) {
      return userId;
    }
  }
  if (typeof body.user === "string" && body.user.length > 0 && body.user.length <= 128) {
    return body.user;
  }
  return undefined;
}

export function resolveCallId(headers: Record<string, string | undefined>): string | undefined {
  const value = headers["x-call-id"] ?? headers["x-correlation-id"];
  if (value && typeof value === "string") return value.slice(0, 128);
  return undefined;
}
