import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { ServerResponse } from "node:http";
import { buildConfig } from "../config/env.js";
import { writeJsonAtomic, readJsonIfExists } from "../utils/atomicFile.js";
import { isRecord } from "../utils/json.js";
import { Redactor } from "../utils/redaction.js";
import { Logger } from "../utils/logger.js";
import { BridgeError } from "../utils/errors.js";
import { PowSolver, parseChallengePayload } from "../deepseek/pow.js";
import { SseAccumulator } from "../deepseek/sseParser.js";
import { DeepSeekPatchParser } from "../deepseek/updateParser.js";
import { COMPLETION_PATH, SESSION_CREATE_PATH, CLIENT_HEADERS, BROWSER_HEADERS, UPSTREAM_USER_AGENT } from "../config/constants.js";
import { CdpConnection, createPage, launchChrome, waitForDebugger, findChrome } from "../cdp.js";
import { findLinuxFolderPicker, isCommandAvailableSync, type CommandAvailability } from "./system.js";
import {
  launchNativeTerminal,
  stopNativeTerminalLaunches,
  type NativeLaunchOptions,
  type NativeStopOptions,
} from "./terminalLaunch.js";
import {
  OPENCODE_PROVIDER_ID,
  PRIMARY_MODELS,
  openCodeModelId,
  resolveModelSelection,
} from "../config/modelCapabilities.js";

const CDP_PORT = 9222;

export interface ActionEvent {
  type: "progress" | "result" | "error" | "log";
  step?: string;
  ok?: boolean;
  message?: string;
  data?: unknown;
}

export function writeSSE(res: ServerResponse, event: ActionEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

export function endSSE(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
  res.end();
}

/* ── AUTH STATUS CHECK (local only — no upstream HTTP) ── */

export async function checkAuthStatus(): Promise<{ valid: boolean; message: string }> {
  const config = buildConfig();
  try {
    const raw = await readJsonIfExists(config.authFile);
    if (!isRecord(raw)) return { valid: false, message: "NO AUTH" };
    const token = typeof raw.token === "string" ? raw.token : "";
    const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
    if (!token && !cookie) return { valid: false, message: "NO AUTH" };
    return { valid: true, message: "AUTH SAVED" };
  } catch (error) {
    return { valid: false, message: "NO AUTH" };
  }
}

/* ── QUICK DIAGNOSTICS (local checks, no upstream PoW/completion) ── */

export async function runDiagnosticsSSE(send: (event: ActionEvent) => void): Promise<void> {
  const config = buildConfig();

  // Check auth file
  let hasAuth = false;
  await (async () => {
    try {
      const raw = await readJsonIfExists(config.authFile);
      if (!isRecord(raw)) throw new Error("missing");
      const token = typeof raw.token === "string" ? raw.token : "";
      const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
      if (!token && !cookie) throw new Error("no credentials");
      hasAuth = true;
      send({ type: "progress", step: "auth_file", ok: true, message: "Present" });
    } catch (error) {
      send({ type: "progress", step: "auth_file", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  })();

  // Check upstream reachability
  if (hasAuth) {
    try {
      const raw = await readJsonIfExists(config.authFile);
      const data = isRecord(raw) ? raw : {};
      const token = typeof data.token === "string" ? data.token : "";
      const cookie = typeof data.cookie === "string" ? data.cookie : "";
      const hifLeim = typeof data.hifLeim === "string" ? data.hifLeim
        : typeof data.hif_leim === "string" ? data.hif_leim : undefined;
      const hifDliq = typeof data.hifDliq === "string" ? data.hifDliq
        : typeof data.hif_dliq === "string" ? data.hif_dliq : undefined;
      const hifHeaders: Record<string, string> = {};
      if (hifLeim) hifHeaders["x-hif-leim"] = hifLeim;
      if (hifDliq) hifHeaders["x-hif-dliq"] = hifDliq;
      const res = await fetch(`${config.baseUrl}`, {
        headers: { ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
      });
      send({ type: "progress", step: "upstream", ok: res.ok, message: `HTTP ${res.status}` });
    } catch (error) {
      send({ type: "progress", step: "upstream", ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  } else {
    send({ type: "progress", step: "upstream", ok: false, message: "skipped: no auth" });
  }

  // Check bridge server health
  try {
    const res = await fetch(`http://127.0.0.1:${config.port ?? 9655}/health`, { signal: AbortSignal.timeout(3000) });
    send({ type: "progress", step: "bridge_server", ok: res.ok, message: res.ok ? "Healthy" : `HTTP ${res.status}` });
  } catch (error) {
    send({ type: "progress", step: "bridge_server", ok: false, message: error instanceof Error ? error.message : String(error) });
  }

  // Check data directory permissions
  try {
    const info = await import("node:fs/promises").then(fs => fs.stat(config.dataDir));
    send({ type: "progress", step: "data_dir", ok: info.isDirectory(), message: info.isDirectory() ? "Exists" : "Not a directory" });
  } catch {
    send({ type: "progress", step: "data_dir", ok: false, message: "Not found" });
  }

  send({ type: "result", ok: true, message: "Diagnostics complete" });
}

/* ── AUTH ── */

const LOCAL_STORAGE_SCAN = `
(function () {
  const found = { token: null, cookie: null };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      let value;
      try { value = localStorage.getItem(key); } catch { continue; }
      if (!value) continue;
      if (typeof value === "string" && /^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$/.test(value) && value.length > 40) {
        if (/token|auth|bearer|user/i.test(key)) { found.token = value; }
      }
      if (!found.token && value.length > 60 && /token|auth|bearer|user/i.test(key) && /^[A-Za-z0-9_-]{20,}$/.test(value)) {
        found.token = value;
      }
    }
  } catch { /* origin not accessible */ }
  try {
    const raw = document.cookie;
    if (raw && raw.length > 3) found.cookie = raw;
  } catch { /* noop */ }
  return found;
})();
`;

async function scanPageStorage(conn: CdpConnection): Promise<{ token?: string; cookie?: string }> {
  try {
    const result = await conn.send("Runtime.evaluate", { expression: LOCAL_STORAGE_SCAN, returnByValue: true });
    const inner = result.result as { value?: unknown } | undefined;
    const value = inner?.value as { token?: string | null; cookie?: string | null } | undefined;
    const out: { token?: string; cookie?: string } = {};
    if (value?.token) out.token = value.token;
    if (value?.cookie) out.cookie = value.cookie;
    return out;
  } catch { return {}; }
}

async function getFullCookie(conn: CdpConnection): Promise<string> {
  try {
    const result = await conn.send("Network.getCookies", { urls: ["https://chat.deepseek.com"] });
    const cookies = result.cookies as Array<{ name: string; value: string }> | undefined;
    if (!cookies || !Array.isArray(cookies)) return "";
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch { return ""; }
}

interface CapturedAuth {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
}

export async function runAuthSSE(
  send: (event: ActionEvent) => void,
  signal?: AbortSignal,
): Promise<CapturedAuth | null> {
  const config = buildConfig();
  const baseHost = new URL(config.baseUrl).hostname;

  if (!findChrome(config.chromePath)) {
    send({ type: "error", message: "Chrome not found. Set CHROME_PATH environment variable." });
    return null;
  }

  send({ type: "progress", step: "chrome", message: "Launching Chrome..." });

  if (fs.existsSync(config.authFile)) {
    fs.rmSync(config.authFile, { force: true });
  }

  if (fs.existsSync(config.chromeProfile)) {
    fs.rmSync(config.chromeProfile, { recursive: true, force: true });
  }

  const child = launchChrome({
    profileDir: config.chromeProfile,
    remoteDebugPort: CDP_PORT,
    chromePath: config.chromePath,
  });
  trackAuthProcess(child);
  const authController = new AbortController();
  activeAuthControllers.add(authController);

  let conn: CdpConnection | null = null;
  let chromeTerminationRequested = false;

  const closeAuthResources = () => {
    if (conn) { try { conn.close(); } catch {} }
  };
  const terminateChromeBestEffort = () => {
    closeAuthResources();
    if (chromeTerminationRequested) return;
    chromeTerminationRequested = true;
    try { child.kill(); } catch {}
  };

  const externalAbortCleanup = () => {
    if (authController.signal.aborted) closeAuthResources();
    else terminateChromeBestEffort();
  };
  const shutdownAbortCleanup = () => { closeAuthResources(); };
  signal?.addEventListener("abort", externalAbortCleanup, { once: true });
  authController.signal.addEventListener("abort", shutdownAbortCleanup, { once: true });

  try {
    await waitForDebugger(CDP_PORT, 20_000);
    send({ type: "progress", step: "chrome", message: "Chrome ready, opening DeepSeek..." });

    const debugUrl = await createPage(CDP_PORT);
    conn = await CdpConnection.connect(debugUrl);

    await conn.send("Page.enable");
    await conn.send("Network.enable");
    await conn.send("Fetch.enable", {
      patterns: [{ urlPattern: "*://chat.deepseek.com/api/v0/*" }],
    });
    await conn.send("Page.navigate", { url: config.baseUrl });

    send({ type: "progress", step: "auth", message: "Browser open. Log in to DeepSeek, then send a message (e.g. 'hi')." });

    const captured: Partial<CapturedAuth> = {};
    let requestsSeen = 0;
    let requestsWithAuth = 0;
    let hifSeen = false;

    conn.on("Fetch.requestPaused", (params: Record<string, unknown>) => {
      const req = params.request as { url?: string; headers?: Record<string, string> } | undefined;
      const requestId = params.requestId as string;
      conn!.send("Fetch.continueRequest", { requestId }).catch(() => {});

      if (!req?.headers) return;
      const url = req.url ?? "";
      if (!url.includes(baseHost) || !url.includes("/api/v0/")) return;

      requestsSeen++;
      const headers = req.headers;
      const auth = headers.authorization ?? headers.Authorization ?? "";
      if (auth && auth.startsWith("Bearer ")) {
        captured.token = auth.slice("Bearer ".length).trim();
        requestsWithAuth++;
      }
      const hifLeim = headers["x-hif-leim"];
      if (hifLeim) {
        captured.hifLeim = hifLeim;
        hifSeen = true;
      }
    });

    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (authController.signal.aborted) { closeAuthResources(); return null; }
      if (signal?.aborted) { terminateChromeBestEffort(); return null; }

      if (captured.token && !captured.hifLeim) {
        try {
          const lsResult = await conn.send("Runtime.evaluate", {
            expression: `localStorage.getItem("hif_leim_cached")`,
            returnByValue: true,
          });
          const lsVal = (lsResult.result as { value?: string })?.value;
          if (lsVal) captured.hifLeim = lsVal.replace(/^"|"$/g, "");
        } catch {}
      }

      if (captured.token) {
        send({ type: "progress", step: "auth", message: "Credentials captured, finalizing..." });
        await new Promise(resolve => setTimeout(resolve, 3000));
        const fullCookie = await getFullCookie(conn);

        let hifLeim = captured.hifLeim;
        try {
          const lsResult = await conn.send("Runtime.evaluate", {
            expression: `localStorage.getItem("hif_leim_cached")`,
            returnByValue: true,
          });
          const lsVal = (lsResult.result as { value?: string })?.value;
          if (lsVal) hifLeim = lsVal.replace(/^"|"$/g, "");
        } catch {}

        const auth: CapturedAuth = {
          token: captured.token,
          cookie: fullCookie,
          hifDliq: captured.hifDliq,
          hifLeim,
        };

        send({ type: "progress", step: "auth", message: "Verifying credentials..." });
        try {
          const verifyRes = await fetch(`${config.baseUrl}${SESSION_CREATE_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(15000),
          });
          const verifyJson = await verifyRes.json() as Record<string, unknown>;
          const verifyCode = typeof verifyJson.code === "number" ? verifyJson.code : 0;
          const verifyData = isRecord(verifyJson.data) ? verifyJson.data : {};
          const bizCode = typeof verifyData.biz_code === "number" ? verifyData.biz_code : 0;
          if (verifyCode !== 0 || bizCode !== 0) {
            const verifyMsg = typeof verifyJson.msg === "string" ? verifyJson.msg : `code ${verifyCode}`;
            const bizMsg = typeof verifyData.biz_msg === "string" ? verifyData.biz_msg : bizCode !== 0 ? `biz_code ${bizCode}` : "";
            const detail = bizMsg ? `${verifyMsg}: ${bizMsg}` : verifyMsg;
            send({ type: "error", step: "auth", message: `Credentials invalid: ${detail}. auth.json NOT saved.` });
            terminateChromeBestEffort();
            return null;
          }
        } catch (err) {
          send({ type: "error", step: "auth", message: `Credential verification failed: ${err instanceof Error ? err.message : String(err)}. auth.json NOT saved.` });
          terminateChromeBestEffort();
          return null;
        }

        fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
        await writeJsonAtomic(config.authFile, auth, 0o600);

        terminateChromeBestEffort();
        return auth;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    send({ type: "error", step: "auth", message: `Timeout: ${requestsSeen} API requests seen, ${requestsWithAuth} with Bearer, hif-leim: ${hifSeen}. Send a message after login.` });
    terminateChromeBestEffort();
    return null;
  } catch (error) {
    send({ type: "error", step: "auth", message: error instanceof Error ? error.message : String(error) });
    if (authController.signal.aborted) closeAuthResources();
    else terminateChromeBestEffort();
    return null;
  } finally {
    signal?.removeEventListener("abort", externalAbortCleanup);
    authController.signal.removeEventListener("abort", shutdownAbortCleanup);
    activeAuthControllers.delete(authController);
  }
}

/* ── DOCTOR ── */

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export async function runDoctorSSE(
  send: (event: ActionEvent) => void,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await Promise.resolve().then(fn);
      results.push({ name, ok: true });
      send({ type: "progress", step: name, ok: true, message: "OK" });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name, ok: false, detail });
      send({ type: "progress", step: name, ok: false, message: detail });
    }
  }

  const config = buildConfig();
  let authState: { token: string; cookie: string; hifLeim?: string; hifDliq?: string; baseUrl: string } | null = null;

  await check("auth file present", async () => {
    const raw = await readJsonIfExists(config.authFile);
    if (!isRecord(raw)) throw new Error(`Missing ${config.authFile}`);
    const token = typeof raw.token === "string" ? raw.token : "";
    const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
    if (!token && !cookie) throw new Error("No token/cookie in auth.json");
    const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
      : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
    const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
      : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
    authState = { token, cookie, hifLeim, hifDliq, baseUrl: config.baseUrl };
  });

  const auth = authState!;

  await check("deepseek reachable", async () => {
    if (!authState) throw new Error("skipped");
    const res = await fetch(`${auth.baseUrl}/api/v0/auth/session`);
    if (res.status !== 404 && res.status !== 200 && res.status >= 400) throw new Error(`HTTP ${res.status}`);
  });

  let challengePayload: ReturnType<typeof parseChallengePayload> | null = null;
  await check("pow challenge", async () => {
    if (!authState) throw new Error("skipped");
    const res = await fetch(`${auth.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
      body: JSON.stringify({ target_path: COMPLETION_PATH }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as Record<string, unknown>;
    const code = typeof json.code === "number" ? json.code : 0;
    if (code !== 0) {
      const msg = typeof json.msg === "string" ? json.msg : `code ${code}`;
      throw new Error(`API error: ${msg}`);
    }
    const data = isRecord(json.data) ? json.data : {};
    const bizCode = typeof data.biz_code === "number" ? data.biz_code : 0;
    if (bizCode !== 0) {
      const bizMsg = typeof data.biz_msg === "string" ? data.biz_msg : `biz_code ${bizCode}`;
      throw new Error(`API biz error: ${bizMsg}`);
    }
    challengePayload = parseChallengePayload(json);
    if (!challengePayload) throw new Error("challenge format not recognized");
  });

  const redactor = new Redactor({ secrets: [auth.token, auth.cookie] });
  const logger = new Logger({ level: "warn", redactor });
  const solver = new PowSolver({ wasmCacheDir: path.join(config.dataDir), logger });
  let solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null = null;

  await check("pow solved", async () => {
    if (!challengePayload) throw new Error("skipped");
    solution = await solver.solve(challengePayload);
  });

  let completionBody: unknown = null;
  await check("completion SSE parsed", async () => {
    if (!authState || !challengePayload || !solution) throw new Error("skipped");
    const sessionRes = await fetch(`${auth.baseUrl}${SESSION_CREATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie, ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}), ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}) },
      body: JSON.stringify({}),
    });
    if (!sessionRes.ok) throw new Error(`session HTTP ${sessionRes.status}`);
    const sessionJson = await sessionRes.json() as Record<string, unknown>;
    const sessionData = isRecord(sessionJson.data) ? sessionJson.data : {};
    const bizData = isRecord(sessionData.biz_data) ? sessionData.biz_data : sessionData;
    let chatSessionId = typeof bizData.id === "string" ? bizData.id : "";
    if (!chatSessionId && isRecord(bizData.chat_session) && typeof bizData.chat_session.id === "string") chatSessionId = bizData.chat_session.id;
    if (!chatSessionId) throw new Error("no chat_session_id");

    const res = await fetch(`${auth.baseUrl}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", ...CLIENT_HEADERS, ...BROWSER_HEADERS,
        "user-agent": UPSTREAM_USER_AGENT, authorization: `Bearer ${auth.token}`, cookie: auth.cookie,
        ...(auth.hifLeim ? { "x-hif-leim": auth.hifLeim } : {}),
        ...(auth.hifDliq ? { "x-hif-dliq": auth.hifDliq } : {}),
        "x-ds-pow-response": Buffer.from(JSON.stringify({ algorithm: solution!.algorithm, challenge: solution!.challenge, salt: solution!.salt, answer: solution!.answer, signature: solution!.signature, target_path: COMPLETION_PATH })).toString("base64"),
      },
      body: JSON.stringify({
        chat_session_id: chatSessionId, parent_message_id: null, prompt: "Say OK only.",
        ref_file_ids: [], model_type: "default", thinking_enabled: false, search_enabled: false,
        action: null, preempt: false,
      }),
    });
    if (!res.ok) throw new Error(`completion HTTP ${res.status}`);
    if (!res.body) throw new Error("empty body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const acc = new SseAccumulator();
    const parser = new DeepSeekPatchParser();
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of acc.push(decoder.decode(value, { stream: true }))) {
        if (event.type === "update") {
          const chunk = parser.apply(event.data);
          if (chunk?.delta) text += chunk.delta;
        }
      }
    }
    if (!text.trim()) throw new Error("no text in stream");
    completionBody = { text: text.slice(0, 80) };
  });

  await check("completion content", async () => {
    const body = completionBody as { text: string } | null;
    if (!body?.text) throw new Error("no content");
  });

  const failed = results.filter(r => !r.ok);
  send({ type: "result", ok: failed.length === 0, message: failed.length === 0 ? "All checks passed" : `${failed.length}/${results.length} failed`, data: results });
  return results;
}

/* ── LAUNCH ── */

function getBridgeEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9655",
    ANTHROPIC_AUTH_TOKEN: "local-key",
    OPENAI_API_BASE: "http://127.0.0.1:9655/v1",
    OPENAI_API_KEY: "local-key",
  };
}

function getClaudeBridgeEnv(): Record<string, string> {
  return {
    ...getBridgeEnv(),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
  };
}

export function buildOpenCodeBridgeConfig(): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "DeepSeek Bridge",
        options: {
          baseURL: "{env:OPENAI_API_BASE}",
          apiKey: "{env:OPENAI_API_KEY}",
        },
        models: Object.fromEntries(PRIMARY_MODELS.map(model => [
          model.id,
          { name: model.displayName },
        ])),
      },
    },
  });
}

function getOpenCodeBridgeEnv(): Record<string, string> {
  return {
    ...getBridgeEnv(),
    OPENCODE_CONFIG_CONTENT: buildOpenCodeBridgeConfig(),
  };
}

export function launchProcess(
  command: string,
  args: string[],
  cwd: string,
  send: (event: ActionEvent) => void,
  extraEnv?: Record<string, string>,
): ChildProcess | null {
  if (!fs.existsSync(cwd)) {
    send({ type: "error", message: `Directory not found: ${cwd}` });
    return null;
  }
  if (!isCommandAvailableSync(command)) {
    send({ type: "error", message: `${command} executable was not found in the Bridge PATH. Install it or start it manually.` });
    return null;
  }

  const env = { ...process.env, ...extraEnv };
  send({ type: "progress", step: "launch", message: `Starting: ${command} ${args.join(" ")}` });
  send({ type: "progress", step: "launch", message: `Working directory: ${cwd}` });

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "ignore",
    detached: true,
    shell: true,
  });

  child.on("error", (err) => {
    send({ type: "error", message: `Failed to start ${command}: ${err.message}` });
  });
  child.on("close", (code) => {
    send({ type: "result", ok: code === 0, message: `${command} exited (code ${code})` });
  });

  // Unref so the bridge server doesn't wait for the child
  child.unref();

  send({ type: "result", ok: true, message: `${command} launched in new window` });
  return child;
}

export function launchClaudeCode(
  workDir: string,
  model: string,
  send: (event: ActionEvent) => void,
  options: NativeLaunchOptions = {},
): ChildProcess | null | Promise<ChildProcess | null> {
  let selectedModel: string;
  try {
    selectedModel = resolveModelSelection(model).canonicalId;
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const args: string[] = [];
  if (selectedModel) args.push("--model", selectedModel);
  const bridgeEnv = getClaudeBridgeEnv();
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return launchNativeTerminal("claude", args, workDir, bridgeEnv, send, options);
  }
  const child = launchProcess("claude", args, workDir, send, bridgeEnv);
  trackProcess(child);
  return child;
}

export function launchOpenCode(
  workDir: string,
  model: string,
  send: (event: ActionEvent) => void,
  options: NativeLaunchOptions = {},
): ChildProcess | null | Promise<ChildProcess | null> {
  let selectedModel: string;
  try {
    selectedModel = openCodeModelId(model);
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    return null;
  }
  const args = ["--model", selectedModel];
  const bridgeEnv = getOpenCodeBridgeEnv();
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return launchNativeTerminal("opencode", args, workDir, bridgeEnv, send, options);
  }
  const child = launchProcess("opencode", args, workDir, send, bridgeEnv);
  trackProcess(child);
  return child;
}

/* ── PROCESS TRACKING ── */

const launchedProcesses: Set<ChildProcess> = new Set();
const activeAuthProcesses: Set<ChildProcess> = new Set();
const activeAuthControllers: Set<AbortController> = new Set();

export const OWNED_PROCESS_TERMINATION_TIMEOUT_MS = 5_000;

type SpawnProcess = typeof spawn;

export interface ProcessStopOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  spawnProcess?: SpawnProcess;
  isProcessAlive?: (pid: number) => boolean;
}

export interface StopLaunchedProcessOptions extends ProcessStopOptions {
  native?: NativeStopOptions;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function childHasExited(child: ChildProcess, isAlive: (pid: number) => boolean): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return child.pid === undefined || !isAlive(child.pid);
}

function shutdownIncomplete(causeCode: string): BridgeError {
  return new BridgeError("Owned process termination was not confirmed.", {
    code: "SHUTDOWN_INCOMPLETE",
    status: 500,
    retryable: false,
    upstreamStage: "shutdown_cleanup",
    causeCode,
  });
}

async function waitForChildExit(
  child: ChildProcess,
  deadline: number,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (childHasExited(child, isAlive)) return true;
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) return childHasExited(child, isAlive);

  return await new Promise<boolean>(resolve => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("close", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(childHasExited(child, isAlive)), remaining);
    child.once("exit", onExit);
    child.once("close", onExit);
    if (childHasExited(child, isAlive)) finish(true);
  });
}

type HelperOutcome =
  | { kind: "close"; code: number | null }
  | { kind: "error" }
  | { kind: "timeout" };

async function runTaskkill(
  pid: number,
  deadline: number,
  spawnProcess: SpawnProcess,
): Promise<HelperOutcome> {
  let killer: ChildProcess;
  try {
    killer = spawnProcess("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    return { kind: "error" };
  }

  return await new Promise<HelperOutcome>(resolve => {
    let settled = false;
    const finish = (outcome: HelperOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killer.removeListener("close", onClose);
      killer.removeListener("error", onError);
      resolve(outcome);
    };
    const onClose = (code: number | null) => finish({ kind: "close", code });
    const onError = () => finish({ kind: "error" });
    const remaining = Math.max(0, deadline - Date.now());
    const timer = setTimeout(() => {
      try { killer.kill(); } catch { /* exact helper only */ }
      finish({ kind: "timeout" });
    }, remaining);
    killer.once("close", onClose);
    killer.once("error", onError);
  });
}

export function trackProcess(child: ChildProcess | null): void {
  if (child) {
    launchedProcesses.add(child);
    child.on("close", () => { launchedProcesses.delete(child); });
  }
}

async function stopTrackedChild(child: ChildProcess, options: ProcessStopOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? OWNED_PROCESS_TERMINATION_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  const deadline = Date.now() + timeoutMs;
  if (childHasExited(child, isAlive)) return;

  const pid = child.pid;
  if (!pid) throw shutdownIncomplete("target_pid_missing");

  if (platform === "win32") {
    const helper = await runTaskkill(pid, deadline, spawnProcess);
    if (await waitForChildExit(child, deadline, isAlive)) return;
    if (helper.kind === "timeout") throw shutdownIncomplete("taskkill_timeout");
    if (helper.kind === "error") throw shutdownIncomplete("taskkill_spawn_failed");
    if (helper.code !== 0) throw shutdownIncomplete("taskkill_nonzero");
    throw shutdownIncomplete("target_exit_timeout");
  }

  let signalled = false;
  try { signalled = child.kill("SIGTERM"); } catch { /* normalized below */ }
  if (!signalled && childHasExited(child, isAlive)) return;
  if (!signalled) throw shutdownIncomplete("signal_send_failed");
  if (!await waitForChildExit(child, deadline, isAlive)) {
    throw shutdownIncomplete("target_exit_timeout");
  }
}

export async function stopLaunchedProcesses(options: StopLaunchedProcessOptions = {}): Promise<void> {
  const failures: BridgeError[] = [];
  const children = [...launchedProcesses];
  const results = await Promise.allSettled(children.map(child => stopTrackedChild(child, options)));
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.status === "fulfilled") {
      launchedProcesses.delete(children[index]!);
    } else {
      failures.push(result.reason instanceof BridgeError
        ? result.reason
        : shutdownIncomplete("process_cleanup_failed"));
    }
  }
  try {
    await stopNativeTerminalLaunches(options.native);
  } catch (error) {
    failures.push(error instanceof BridgeError ? error : shutdownIncomplete("native_cleanup_failed"));
  }
  if (failures.length > 0) throw failures[0];
}

export function trackAuthProcess(child: ChildProcess): void {
  activeAuthProcesses.add(child);
  child.on("close", () => { activeAuthProcesses.delete(child); });
}

export async function stopActiveAuthChrome(options: ProcessStopOptions = {}): Promise<void> {
  const children = [...activeAuthProcesses];
  for (const controller of activeAuthControllers) controller.abort();
  activeAuthControllers.clear();
  const failures: BridgeError[] = [];
  const results = await Promise.allSettled(children.map(child => stopTrackedChild(child, options)));
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    if (result.status === "fulfilled") {
      activeAuthProcesses.delete(children[index]!);
    } else {
      failures.push(result.reason instanceof BridgeError
        ? result.reason
        : shutdownIncomplete("auth_process_cleanup_failed"));
    }
  }
  if (failures.length > 0) throw failures[0];
}

/* ── FOLDER PICKER ── */

export interface PickFolderResult {
  path: string | null;
  cancelled: boolean;
  supported: boolean;
}

export interface PickFolderOptions {
  platform?: NodeJS.Platform;
  commandAvailable?: CommandAvailability;
}

function normalizePickedPath(selected: string): string {
  if (fs.existsSync(selected)) return selected;
  const repaired = Buffer.from(selected, "latin1").toString("utf8");
  return !repaired.includes("\uFFFD") && fs.existsSync(repaired) ? repaired : selected;
}

function runUnixFolderPicker(
  command: string,
  args: string[],
  isCancellation: (code: number | null, stderr: string) => boolean,
  normalize: (selected: string) => string = selected => selected,
): Promise<PickFolderResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failedToStart = false;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.on("error", () => {
      failedToStart = true;
      resolve({ path: null, cancelled: false, supported: false });
    });
    child.on("close", code => {
      if (failedToStart) return;
      const selected = Buffer.concat(stdout).toString("utf8").replace(/[\r\n]+$/, "");
      if (selected) {
        resolve({ path: normalize(selected), cancelled: false, supported: true });
        return;
      }
      const errorText = Buffer.concat(stderr).toString("utf8");
      resolve({ path: null, cancelled: isCancellation(code, errorText), supported: true });
    });
  });
}

export async function pickFolder(options: PickFolderOptions = {}): Promise<PickFolderResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return runUnixFolderPicker(
      "osascript",
      ["-e", 'POSIX path of (choose folder with prompt "Select working directory")'],
      (_code, stderr) => /User canceled|\(-128\)/i.test(stderr),
      selected => selected.length > 1 && selected.endsWith("/") ? selected.slice(0, -1) : selected,
    );
  }

  if (platform === "linux") {
    const picker = await findLinuxFolderPicker(options.commandAvailable);
    if (picker === "zenity") {
      return runUnixFolderPicker(
        "zenity",
        ["--file-selection", "--directory", "--title=Select working directory"],
        code => code === 1,
      );
    }
    if (picker === "kdialog") {
      return runUnixFolderPicker(
        "kdialog",
        ["--getexistingdirectory", process.cwd(), "--title", "Select working directory"],
        code => code === 1,
      );
    }
    return { path: null, cancelled: false, supported: false };
  }

  if (platform !== "win32") return { path: null, cancelled: false, supported: false };

  const ps = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [Console]::OutputEncoding",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$f.Description = 'Select working directory'",
    "$f.ShowNewFolderButton = $true",
    "if ($f.ShowDialog() -eq 'OK') { [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($f.SelectedPath))) }",
  ].join("; ");

  return new Promise<PickFolderResult>((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-STA", "-Command", ps], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    });
    child.on("close", () => {
      const encoded = Buffer.concat(stdout).toString("ascii").trim();
      if (encoded) {
        const selected = Buffer.from(encoded, "base64").toString("utf8");
        resolve({ path: normalizePickedPath(selected), cancelled: false, supported: true });
      } else {
        resolve({ path: null, cancelled: true, supported: true });
      }
    });
    child.on("error", () => { resolve({ path: null, cancelled: false, supported: true }); });
  });
}

/* ── LOGOUT ── */

export async function performLogout(): Promise<{ ok: boolean; message: string }> {
  const config = buildConfig();
  try {
    await fs.promises.rm(config.chromeProfile, { recursive: true, force: true });
    await fs.promises.rm(config.authFile, { force: true });
    return { ok: true, message: "Logged out" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
