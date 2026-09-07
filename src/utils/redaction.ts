export interface RedactorOptions {
  secrets?: string[];
}

const SENSITIVE_KEY_PATTERN = /token|cookie|authorization|secret|api[_-]?key|password|credential|session/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export class Redactor {
  private readonly secrets: string[];

  constructor(options: RedactorOptions = {}) {
    this.secrets = (options.secrets ?? []).filter(Boolean);
  }

  addSecret(value: unknown): void {
    if (typeof value !== "string" || value.length < 6) return;
    if (!this.secrets.includes(value)) this.secrets.push(value);
  }

  redactText(text: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (!secret) continue;
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.split(escaped).join("[REDACTED]");
    }
    return out
      .replace(/authorization:\s*Bearer\s+\S+/gi, "authorization: Bearer [REDACTED]")
      .replace(/cookie:\s*[^\r\n]+/gi, "cookie: [REDACTED]")
      .replace(/"token"\s*:\s*"[^"]+"/gi, '"token": "[REDACTED]"')
      .replace(/"cookie"\s*:\s*"[^"]+"/gi, '"cookie": "[REDACTED]"');
  }

  redactValue(key: string, value: unknown): unknown {
    if (isSensitiveKey(key)) {
      if (value === null || value === undefined) return value;
      return "[REDACTED]";
    }
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map(item => this.redactValue(key, item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactValue(k, v);
      return out;
    }
    return value;
  }
}

export function collectAuthSecrets(auth: Record<string, unknown>): string[] {
  const secrets: string[] = [];
  for (const key of ["token", "cookie", "authorization", "hif_dliq", "hif_leim", "hifDliq", "hifLeim"]) {
    const value = auth[key];
    if (typeof value === "string" && value.length >= 6) secrets.push(value);
  }
  return secrets;
}
