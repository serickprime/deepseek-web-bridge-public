import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../src/config/env.js";
import { readJsonIfExists } from "../src/utils/atomicFile.js";
import { isRecord } from "../src/utils/json.js";
import { Redactor } from "../src/utils/redaction.js";
import { Logger } from "../src/utils/logger.js";
import { PowSolver, parseChallengePayload } from "../src/deepseek/pow.js";
import { SseAccumulator } from "../src/deepseek/sseParser.js";
import { DeepSeekPatchParser } from "../src/deepseek/updateParser.js";
import { COMPLETION_PATH, SESSION_CREATE_PATH, CLIENT_HEADERS, BROWSER_HEADERS, UPSTREAM_USER_AGENT } from "../src/config/constants.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  [OK]   ${name}`);
    })
    .catch(error => {
      results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
      console.log(`  [FAIL] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
}

async function requireAuthFile(): Promise<{ token: string; cookie: string; hifLeim?: string; hifDliq?: string; baseUrl: string }> {
  const config = buildConfig();
  const raw = await readJsonIfExists(config.authFile);
  if (!isRecord(raw)) {
    throw new Error(`Missing ${config.authFile}. Run \`npm run auth\` first.`);
  }
  const token = typeof raw.token === "string" ? raw.token : "";
  const cookie = typeof raw.cookie === "string" ? raw.cookie : "";
  if (!token && !cookie) {
    throw new Error(`No token/cookie in ${config.authFile}. Run \`npm run auth\` again.`);
  }
  const hifLeim = typeof raw.hifLeim === "string" ? raw.hifLeim
    : typeof raw.hif_leim === "string" ? raw.hif_leim : undefined;
  const hifDliq = typeof raw.hifDliq === "string" ? raw.hifDliq
    : typeof raw.hif_dliq === "string" ? raw.hif_dliq : undefined;
  return { token, cookie, hifLeim, hifDliq, baseUrl: config.baseUrl };
}

export async function runDoctor(): Promise<void> {
  console.log("DeepSeek Web Bridge doctor");
  console.log("--------------------------");

  const state: { auth: { token: string; cookie: string; hifLeim?: string; hifDliq?: string; baseUrl: string } | null } = { auth: null };

  await check("auth file present with credentials", async () => {
    state.auth = await requireAuthFile();
  });

  await check("deepseek reachable", async () => {
    if (!state.auth) throw new Error("skipped: no auth");
    const res = await fetch(`${state.auth.baseUrl}`, {
      headers: { ...CLIENT_HEADERS, ...BROWSER_HEADERS, "user-agent": UPSTREAM_USER_AGENT },
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  });

  let challengePayload: ReturnType<typeof parseChallengePayload> | null = null;
  await check("pow challenge fetched", async () => {
    if (!state.auth) throw new Error("skipped: no auth");
    const body = JSON.stringify({ target_path: COMPLETION_PATH });
    const res = await fetch(`${state.auth.baseUrl}/api/v0/chat/create_pow_challenge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...CLIENT_HEADERS,
        ...BROWSER_HEADERS,
        "user-agent": UPSTREAM_USER_AGENT,
        authorization: `Bearer ${state.auth.token}`,
        cookie: state.auth.cookie,
        ...(state.auth.hifLeim ? { "x-hif-leim": state.auth.hifLeim } : {}),
        ...(state.auth.hifDliq ? { "x-hif-dliq": state.auth.hifDliq } : {}),
      },
      body,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as Record<string, unknown>;
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
    if (!challengePayload) throw new Error("challenge payload format not recognized");
  });

  const redactor = new Redactor({ secrets: [state.auth?.token ?? "", state.auth?.cookie ?? "", state.auth?.hifLeim ?? "", state.auth?.hifDliq ?? ""] });
  const logger = new Logger({ level: "warn", redactor });
  const solver = new PowSolver({ wasmCacheDir: path.join(buildConfig().dataDir), logger });

  let solution: { answer: number; signature: string; algorithm: string; salt: string; challenge: string } | null = null;
  await check("pow solved", async () => {
    if (!challengePayload) throw new Error("skipped: no challenge");
    const solved = await solver.solve(challengePayload);
    solution = solved;
  });

  let completionBody: unknown = null;
  await check("completion SSE stream parsed", async () => {
    if (!state.auth) throw new Error("skipped: no auth");
    if (!challengePayload) throw new Error("skipped: no challenge");
    if (!solution) throw new Error("skipped: no solution");

    const sessionRes = await fetch(`${state.auth.baseUrl}${SESSION_CREATE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...CLIENT_HEADERS,
        ...BROWSER_HEADERS,
        "user-agent": UPSTREAM_USER_AGENT,
        authorization: `Bearer ${state.auth.token}`,
        cookie: state.auth.cookie,
        ...(state.auth.hifLeim ? { "x-hif-leim": state.auth.hifLeim } : {}),
        ...(state.auth.hifDliq ? { "x-hif-dliq": state.auth.hifDliq } : {}),
      },
      body: JSON.stringify({}),
    });
    if (!sessionRes.ok) throw new Error(`session create HTTP ${sessionRes.status}`);
    const sessionJson = (await sessionRes.json()) as Record<string, unknown>;
    const sessionData = isRecord(sessionJson.data) ? sessionJson.data : {};
    const bizData = isRecord(sessionData.biz_data) ? sessionData.biz_data : sessionData;
    let chatSessionId = typeof bizData.id === "string" ? bizData.id : "";
    if (!chatSessionId && isRecord(bizData.chat_session) && typeof bizData.chat_session.id === "string") {
      chatSessionId = bizData.chat_session.id;
    }
    if (!chatSessionId) {
      throw new Error("no chat_session_id from session create");
    }

    const payload = {
      chat_session_id: chatSessionId,
      parent_message_id: null,
      prompt: "Say OK only.",
      ref_file_ids: [],
      model_type: "default",
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    };

    const res = await fetch(`${state.auth.baseUrl}${COMPLETION_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...CLIENT_HEADERS,
        ...BROWSER_HEADERS,
        "user-agent": UPSTREAM_USER_AGENT,
        authorization: `Bearer ${state.auth.token}`,
        cookie: state.auth.cookie,
        ...(state.auth.hifLeim ? { "x-hif-leim": state.auth.hifLeim } : {}),
        ...(state.auth.hifDliq ? { "x-hif-dliq": state.auth.hifDliq } : {}),
        ...(solution ? { "x-ds-pow-response": Buffer.from(JSON.stringify({
          algorithm: solution.algorithm,
          challenge: solution.challenge,
          salt: solution.salt,
          answer: solution.answer,
          signature: solution.signature,
          target_path: COMPLETION_PATH,
        })).toString("base64") } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`completion HTTP ${res.status}`);
    if (!res.body) throw new Error("empty completion body");

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
    if (!text.trim()) throw new Error("no text content in completion stream");
    completionBody = { text: text.slice(0, 80) };
  });

  await check("completion returns content", async () => {
    const body = completionBody as { text: string } | null;
    if (!body?.text) throw new Error("no content captured");
  });

  console.log("");
  const failed = results.filter(r => !r.ok);
  if (failed.length === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${failed.length} of ${results.length} checks failed.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runDoctor().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
