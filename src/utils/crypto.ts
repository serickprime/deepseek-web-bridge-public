import crypto from "node:crypto";
import { timingSafeEqual } from "node:crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

export function randomHex(prefix = ""): string {
  return prefix + crypto.randomBytes(16).toString("hex");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacFingerprint(value: string, salt: string): string {
  return crypto.createHmac("sha256", salt).update(value, "utf8").digest("hex").slice(0, 12);
}
