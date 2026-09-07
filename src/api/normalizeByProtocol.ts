import { normalizeAnthropic } from "./normalizeAnthropic.js";
import { normalizeOpenAI } from "./normalizeOpenAI.js";
import { normalizeResponses } from "./normalizeResponses.js";
import type { CanonicalRequest } from "./canonical.js";

export type Protocol = "openai" | "anthropic" | "responses";

export function normalizeByProtocol(
  protocol: Protocol,
  body: unknown,
  headers: Record<string, string | undefined>,
): CanonicalRequest {
  switch (protocol) {
    case "openai":
      return normalizeOpenAI(body, headers);
    case "anthropic":
      return normalizeAnthropic(body, headers);
    case "responses":
      return normalizeResponses(body, headers);
  }
}
