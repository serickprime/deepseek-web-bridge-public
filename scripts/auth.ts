import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../src/config/env.js";
import { writeJsonAtomic } from "../src/utils/atomicFile.js";
import { isRecord } from "../src/utils/json.js";
import { CdpConnection, createPage, launchChrome, waitForDebugger } from "./cdp.js";

import { COMPLETION_PATH, SESSION_CREATE_PATH, CLIENT_HEADERS, BROWSER_HEADERS, UPSTREAM_USER_AGENT } from "../src/config/constants.js";

const CDP_PORT = 9222;

interface CapturedAuth {
  token: string;
  cookie: string;
  hifDliq?: string;
  hifLeim?: string;
}

function extractCookieHeader(headers: Record<string, string>): string {
  const raw = headers.cookie ?? headers.Cookie ?? "";
  return raw.split(";").map(p => p.trim()).filter(Boolean).join("; ");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

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
    const result = await conn.send("Runtime.evaluate", {
      expression: LOCAL_STORAGE_SCAN,
      returnByValue: true,
    });
    const inner = result.result as { value?: unknown } | undefined;
    const value = inner?.value as { token?: string | null; cookie?: string | null } | undefined;
    const out: { token?: string; cookie?: string } = {};
    if (value?.token) out.token = value.token;
    if (value?.cookie) out.cookie = value.cookie;
    return out;
  } catch {
    return {};
  }
}

async function getFullCookie(conn: CdpConnection): Promise<string> {
  try {
    const result = await conn.send("Network.getCookies", { urls: ["https://chat.deepseek.com"] });
    const cookies = result.cookies as Array<{ name: string; value: string }> | undefined;
    if (!cookies || !Array.isArray(cookies)) return "";
    return cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function capture(conn: CdpConnection, expectedHost: string, timeoutMs: number): Promise<CapturedAuth> {
  const captured: Partial<CapturedAuth> = {};
  let requestsSeen = 0;
  let requestsWithAuth = 0;
  let hifSeen = false;

  conn.on("Fetch.requestPaused", (params: Record<string, unknown>) => {
    const req = params.request as { url?: string; headers?: Record<string, string> } | undefined;

    const requestId = params.requestId as string;
    conn.send("Fetch.continueRequest", { requestId }).catch(() => {});

    if (!req?.headers) return;
    const url = req.url ?? "";
    if (!url.includes(expectedHost) || !url.includes("/api/v0/")) return;

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

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (captured.token) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const fullCookie = await getFullCookie(conn);

      // Prefer hif_leim from localStorage (the canonical source)
      let hifLeim = captured.hifLeim;
      try {
        const lsResult = await conn.send("Runtime.evaluate", {
          expression: `localStorage.getItem("hif_leim_cached")`,
          returnByValue: true,
        });
        const lsVal = (lsResult.result as { value?: string })?.value;
        if (lsVal) {
          hifLeim = lsVal.replace(/^"|"$/g, "");
        }
      } catch { /* fallback to network-captured value */ }

      return {
        token: captured.token,
        cookie: fullCookie,
        hifDliq: captured.hifDliq,
        hifLeim,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Timed out waiting for a logged-in session with Bearer auth. ` +
    `Seen ${requestsSeen} requests to ${expectedHost}, ${requestsWithAuth} with Bearer auth, hif-leim seen: ${hifSeen}. ` +
    `IMPORTANT: After logging in, send at least one message (e.g. type "hi" and press Enter) so an authenticated API request is generated. ` +
    `If you just logged in, close this window and run \`npm run auth\` again — the profile is preserved.`,
  );
}

function printSummary(auth: CapturedAuth): void {
  console.log("");
  console.log("Captured credentials:");
  console.log(`  token:     ${auth.token.length} chars`);
  console.log(`  cookie:    ${auth.cookie.length} chars`);
  if (auth.hifDliq) console.log(`  x-hif-dliq: captured`);
  if (auth.hifLeim) console.log(`  x-hif-leim: captured`);
  console.log("");
}

export async function runAuth(): Promise<void> {
  const config = buildConfig();
  const baseHost = new URL(config.baseUrl).hostname;

  if (fs.existsSync(config.authFile)) {
    console.log(`Found existing ${config.authFile}. Removing so the new login replaces it.`);
    fs.rmSync(config.authFile, { force: true });
  }

  if (fs.existsSync(config.chromeProfile)) {
    console.log(`Clearing dedicated profile ${config.chromeProfile} for fresh re-auth.`);
    fs.rmSync(config.chromeProfile, { recursive: true, force: true });
  }

  console.log(`Launching Chrome with profile ${config.chromeProfile}...`);
  const child = launchChrome({
    profileDir: config.chromeProfile,
    remoteDebugPort: CDP_PORT,
    chromePath: config.chromePath,
  });
  process.on("exit", () => {
    child.kill();
  });

  await waitForDebugger(CDP_PORT, 20_000);
  const debugUrl = await createPage(CDP_PORT);
  const conn = await CdpConnection.connect(debugUrl);

  await conn.send("Page.enable");
  await conn.send("Network.enable");
  await conn.send("Fetch.enable", {
    patterns: [{ urlPattern: "*://chat.deepseek.com/api/v0/*" }],
  });
  await conn.send("Page.navigate", { url: config.baseUrl });

  console.log("");
  console.log("======================================================================");
  console.log("  Log in to chat.deepseek.com in the opened browser (CAPTCHA/2FA ok).");
  console.log("  After logging in, SEND A MESSAGE (type 'hi' and press Enter).");
  console.log("  This generates the x-hif-leim header needed for API access.");
  console.log(`  Waiting up to 5 minutes...`);
  console.log("======================================================================");
  console.log("");

  try {
    const auth = await capture(conn, baseHost, 5 * 60 * 1000);
    printSummary(auth);

    console.log("Verifying credentials against DeepSeek...");
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
      throw new Error(`Credentials invalid: ${detail}. auth.json NOT saved.`);
    }
    console.log("Credentials verified OK.");

    fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
    await writeJsonAtomic(config.authFile, auth, 0o600);
    console.log(`Saved to ${config.authFile} (mode 0600).`);
    console.log("You can now start the bridge with `npm start`.");
  } finally {
    conn.close();
    child.kill();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runAuth().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
