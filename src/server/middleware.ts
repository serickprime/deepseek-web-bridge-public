import { BridgeError } from "../utils/errors.js";
import { LOOPBACK_ORIGINS } from "../config/constants.js";

export interface SecurityOptions {
  proxyApiKey: string | null;
  corsOrigins: string[];
  maxBytes: number;
  loopback: boolean;
}

export const PUBLIC_PATHS: ReadonlySet<string> = new Set(["/", "/health", "/readyz", "/api/system"]);

export function isPublicPath(method: string, path: string): boolean {
  const pathname = path.split("?")[0] ?? path;
  if (pathname.startsWith("/assets/")) return true;
  if (pathname.startsWith("/bridge/")) return true;
  if (method !== "GET") return false;
  return PUBLIC_PATHS.has(pathname);
}

export function isLoopbackOrigin(origin: string): boolean {
  if (LOOPBACK_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") return true;
  } catch { /* not a URL */ }
  return false;
}

export function checkApiKey(
  req: { headers: Record<string, string | string[] | undefined> },
  options: SecurityOptions,
): void {
  if (!options.proxyApiKey) return;
  const suppliedRaw = req.headers["x-api-key"] ?? req.headers["authorization"];
  const supplied = Array.isArray(suppliedRaw) ? suppliedRaw[0] : suppliedRaw;
  const normalized = supplied?.replace(/^Bearer\s+/i, "");
  if (normalized !== options.proxyApiKey) {
    throw new BridgeError("Invalid or missing API key.", { code: "AUTH_MISSING", status: 401 });
  }
}

export function corsAllowed(origin: string | undefined, options: SecurityOptions): boolean {
  if (!origin) return true;
  if (options.loopback && isLoopbackOrigin(origin)) return true;
  return options.corsOrigins.includes(origin);
}

export function corsHeaders(origin: string | undefined, options: SecurityOptions): Record<string, string> {
  if (!origin) return {};
  if (!corsAllowed(origin, options)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key, anthropic-version",
    "access-control-max-age": "86400",
  };
}

export async function readBody(req: { raw: unknown }, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const stream = req.raw as import("node:http").IncomingMessage;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > maxBytes) {
      throw new BridgeError(`Request body exceeds ${maxBytes} bytes.`, { code: "REQUEST_TOO_LARGE", status: 413 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
