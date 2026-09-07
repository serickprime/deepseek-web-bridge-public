import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_BASE_URL,
  DEFAULT_HOST,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MIN_PROXY_API_KEY_LENGTH,
} from "./constants.js";

export interface AppConfig {
  host: string;
  port: number;
  baseUrl: string;
  dataDir: string;
  authFile: string;
  sessionsFile: string;
  chromeProfile: string;
  chromePath: string | null;
  proxyApiKey: string | null;
  corsOrigins: string[];
  maxBytes: number;
  timeoutMs: number;
  debug: boolean;
  toolDiagnostics: boolean;
  setupToken: string;
}

function numberValue(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const normalized = String(value).toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

function str(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function optionalString(value: unknown): string | null {
  const normalized = str(value);
  return normalized ? normalized : null;
}

function splitList(value: unknown): string[] {
  return str(value)
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function parseDotEnv(file: string, target: Record<string, string>): void {
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in target)) target[key] = value;
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === "localhost") return true;
  const v4 = normalized.replace(/^\[|\]$/g, "");
  if (v4 === "127.0.0.1" || v4 === "0:0:0:0:0:0:0:1" || v4 === "::1") return true;
  return /^127\.\d+\.\d+\.\d+$/.test(v4);
}

export function loadDotEnv(cwd: string): Record<string, string> {
  const merged: Record<string, string> = {};
  const root = process.cwd();
  parseDotEnv(path.join(root, ".env"), merged);
  parseDotEnv(path.join(cwd, ".env"), merged);
  return merged;
}

export function buildConfig(input: NodeJS.ProcessEnv & Record<string, string | undefined> = process.env): AppConfig {
  const dot = loadDotEnv(process.cwd());
  const get = (key: string): string | undefined => input[key] ?? dot[key];

  const host = str(get("HOST"), DEFAULT_HOST);
  const port = numberValue(get("PORT"), DEFAULT_PORT);
  const dataDir = str(get("DS_DATA_DIR"), path.join(process.cwd(), "data"));

  const proxyApiKey = optionalString(get("PROXY_API_KEY"));
  if (!isLoopbackHost(host) && !proxyApiKey) {
    throw new Error(
      `HOST "${host}" is not loopback. Set PROXY_API_KEY (at least ${MIN_PROXY_API_KEY_LENGTH} chars) to expose the bridge.`,
    );
  }
  if (proxyApiKey && proxyApiKey.length < MIN_PROXY_API_KEY_LENGTH) {
    throw new Error(`PROXY_API_KEY must be at least ${MIN_PROXY_API_KEY_LENGTH} characters.`);
  }

  return {
    host,
    port,
    baseUrl: str(get("DS_BASE_URL"), DEFAULT_BASE_URL).replace(/\/+$/, ""),
    dataDir,
    authFile: str(get("DS_AUTH_FILE"), path.join(dataDir, "auth.json")),
    sessionsFile: str(get("DS_SESSIONS_FILE"), path.join(dataDir, "sessions.json")),
    chromeProfile: str(get("DS_CHROME_PROFILE"), path.join(dataDir, "chrome-profile")),
    chromePath: optionalString(get("CHROME_PATH")),
    proxyApiKey,
    corsOrigins: splitList(get("PROXY_CORS_ORIGINS")),
    maxBytes: numberValue(get("DS_MAX_BODY_BYTES"), DEFAULT_MAX_BODY_BYTES),
    timeoutMs: numberValue(get("DS_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS),
    debug: boolValue(get("DS_DEBUG")),
    toolDiagnostics: boolValue(get("BRIDGE_TOOL_DIAGNOSTICS")),
    setupToken: optionalString(get("SETUP_TOKEN")) ?? "",
  };
}

export function isLoopbackHostAddress(host: string): boolean {
  return isLoopbackHost(host);
}
