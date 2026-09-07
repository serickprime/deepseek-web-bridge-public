import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BridgeError, httpStatusForCode } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import type { SecurityOptions } from "./middleware.js";
import { checkApiKey, corsAllowed, corsHeaders, isPublicPath, readBody } from "./middleware.js";
import type { CompletionHandler } from "../api/handler.js";
import type { Protocol } from "../api/normalizeByProtocol.js";
import { normalizeByProtocol } from "../api/normalizeByProtocol.js";
import { toOpenAIChat } from "./outputOpenAI.js";
import { anthropicErrorResponse, toAnthropicMessage, toAnthropicPublicError } from "./outputAnthropic.js";
import { toResponses } from "./outputResponses.js";
import { ProtocolStream } from "./protocolStream.js";
import type { SessionManager } from "../auth/sessionManager.js";
import type { Redactor } from "../utils/redaction.js";
import type { AuthCredentials } from "../deepseek/client.js";
import { LANDING_PAGE_HTML } from "./landingPage.js";
import { runAuthSSE, runDoctorSSE, runDiagnosticsSSE, checkAuthStatus, launchClaudeCode, launchOpenCode, writeSSE, endSSE, pickFolder, performLogout, stopActiveAuthChrome, type ActionEvent } from "./actions.js";
import { getSystemCapabilities, type SystemCapabilities } from "./system.js";
import { DEFAULT_MODEL_ID, resolveModelSelection } from "../config/modelCapabilities.js";

export interface RouteContext {
  security: SecurityOptions;
  handler: CompletionHandler;
  sessions: SessionManager;
  logger: Logger;
  redactor: Redactor;
  models: Array<{ id: string; object: string; owned_by: string }>;
  ready: () => boolean;
  gracefulStop?: () => Promise<void>;
  setRuntimeAuth?: (auth: AuthCredentials) => Promise<void> | void;
  clearRuntimeAuth?: () => Promise<void> | void;
  systemInfo?: () => Promise<SystemCapabilities>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, body: string, contentType = "text/plain"): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logRouteError(error: unknown, logger: Logger, latencyMs?: number): void {
  if (error instanceof BridgeError) {
    logger.warn("route_error", {
      code: error.code,
      status: error.status,
      retryable: error.retryable,
      stage: error.upstreamStage ?? "route",
      ...(error.upstreamStage ? { upstream_stage: error.upstreamStage } : {}),
      outcome: "failure",
      failure_class: error.code,
      ...(error.causeCode ? { cause_code: error.causeCode } : {}),
      ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
    });
  } else {
    logger.error("route_error_unhandled", {
      stage: "route",
      outcome: "failure",
      failure_class: "UNHANDLED_ERROR",
      ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
    });
  }
}

function routeError(res: ServerResponse, error: unknown, ctx: RouteContext, requestRef: string): void {
  logRouteError(error, ctx.logger.withRequestRef(requestRef));
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const status = error instanceof BridgeError ? error.status : 500;
  const code = error instanceof BridgeError ? error.code : "INTERNAL_ERROR";
  const message = error instanceof BridgeError ? error.message : "Internal server error";
  sendJson(res, status, { error: { type: code, message } });
}

function buildProtocolStream(
  protocol: Protocol,
  model: string,
  res: ServerResponse,
  streaming: boolean,
): ProtocolStream {
  if (streaming) {
    const headers = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (protocol !== "anthropic") res.writeHead(200, headers);
    return new ProtocolStream(protocol, model, chunk => {
      if (res.writableEnded || res.destroyed) return;
      if (!res.headersSent) res.writeHead(200, headers);
      res.write(chunk);
    });
  }
  // Non-streaming: collect-only dummy that discards writes
  return new ProtocolStream(protocol, model, () => {});
}

function handleCompletion(ctx: RouteContext, protocol: Protocol, modelFallback: string) {
  return async (req: IncomingMessage, res: ServerResponse, requestRef: string): Promise<void> => {
    const logger = ctx.logger.withRequestRef(requestRef);
    const startedAt = Date.now();
    let stream: ProtocolStream | undefined;
    let anthropicStreaming = false;
    try {
      const raw = await readBody({ raw: req }, ctx.security.maxBytes);
      const body = JSON.parse(raw.toString("utf8"));
      const normalized = normalizeByProtocol(protocol, body, req.headers as Record<string, string | undefined>);
      resolveModelSelection(normalized.model, normalized.reasoning, normalized.search);
      logger.info("completion_request", {
        protocol,
        model: normalized.model,
        stream: normalized.stream,
        tools: normalized.tools.length,
        stage: "request_normalized",
        outcome: "start",
      });
      anthropicStreaming = protocol === "anthropic" && normalized.stream;
      stream = buildProtocolStream(protocol, normalized.model, res, normalized.stream);
      const runResult = await ctx.handler.run({
        protocol,
        request: normalized,
        headers: req.headers as Record<string, string | undefined>,
        body: body as Record<string, unknown>,
        stream,
        logger,
      });
      if (!normalized.stream) {
        let payload: unknown;
        if (protocol === "openai") payload = toOpenAIChat(runResult.result, normalized.model);
        if (protocol === "anthropic") payload = toAnthropicMessage(runResult.result, normalized.model, normalized);
        if (protocol === "responses") payload = toResponses(runResult.result, normalized.model);
        sendJson(res, 200, payload);
      } else {
        res.end();
      }
      logger.info("completion_done", {
        upstream_ref: logger.opaqueRef("upstream", runResult.upstreamKey),
        stage: "downstream_complete",
        outcome: "success",
        latency_ms: Date.now() - startedAt,
      });
    } catch (error) {
      if (res.writableEnded) return;
      if (protocol === "anthropic") {
        const publicError = toAnthropicPublicError(error);
        logRouteError(error, logger, Date.now() - startedAt);
        if (anthropicStreaming && stream?.fail(publicError)) {
          if (!res.writableEnded) res.end();
          return;
        }
        if (!res.headersSent) {
          const status = error instanceof BridgeError ? error.status : 500;
          sendJson(res, status, anthropicErrorResponse(publicError));
          return;
        }
        if (!res.writableEnded) res.end();
        return;
      }
      routeError(res, error, ctx, requestRef);
    }
  };
}

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const PUBLIC_ASSETS_DIR = resolve(process.cwd(), "public");

async function serveStaticAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const safePath = join(PUBLIC_ASSETS_DIR, pathname.replace(/^\//, ""));
  const resolved = resolve(safePath);
  if (!resolved.startsWith(PUBLIC_ASSETS_DIR)) {
    sendJson(res, 403, { error: { type: "FORBIDDEN", message: "Access denied" } });
    return;
  }
  try {
    const info = await stat(resolved);
    if (!info.isFile()) { sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Not found" } }); return; }
    const ext = resolved.substring(resolved.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    const data = await readFile(resolved);
    res.writeHead(200, { "content-type": contentType, "cache-control": "public, max-age=3600" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Not found" } });
  }
}

export function routes(ctx: RouteContext): Array<{
  method: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse, requestRef: string) => Promise<void>;
}> {
  return [
    {
      method: "GET",
      path: "/",
      handler: async (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LANDING_PAGE_HTML);
      },
    },
    {
      method: "GET",
      path: "/health",
      handler: async (_req, res) => sendJson(res, 200, { status: "ok" }),
    },
    {
      method: "GET",
      path: "/readyz",
      handler: async (_req, res) => sendJson(res, ctx.ready() ? 200 : 503, { ready: ctx.ready() }),
    },
    {
      method: "GET",
      path: "/api/system",
      handler: async (_req, res) => sendJson(res, 200, await (ctx.systemInfo?.() ?? getSystemCapabilities())),
    },
    {
      method: "GET",
      path: "/v1/models",
      handler: async (_req, res) => {
        const data = ctx.models.map(m => ({ ...m, created: Math.floor(Date.now() / 1000) }));
        sendJson(res, 200, { object: "list", data });
      },
    },
    {
      method: "POST",
      path: "/v1/chat/completions",
      handler: handleCompletion(ctx, "openai", DEFAULT_MODEL_ID),
    },
    {
      method: "POST",
      path: "/v1/responses",
      handler: handleCompletion(ctx, "responses", DEFAULT_MODEL_ID),
    },
    {
      method: "POST",
      path: "/v1/messages",
      handler: handleCompletion(ctx, "anthropic", DEFAULT_MODEL_ID),
    },
    {
      method: "GET",
      path: "/v1/sessions",
      handler: async (_req, res) => {
        const list = ctx.sessions.listSessions().map(s => ({
          session_id: s.sessionId,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          name: s.name ?? null,
        }));
        sendJson(res, 200, { object: "list", data: list });
      },
    },
    {
      method: "POST",
      path: "/v1/sessions",
      handler: async (req, res) => {
        try {
          const raw = await readBody({ raw: req }, ctx.security.maxBytes);
          const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          const name = typeof body.name === "string" ? body.name.slice(0, 64) : undefined;
          const session = await ctx.sessions.addSession(makeId(), name);
          sendJson(res, 201, { object: "session", id: session.sessionId });
        } catch (error) {
          routeError(res, error, ctx, makeId());
        }
      },
    },
    {
      method: "DELETE",
      path: "/v1/sessions/:id",
      handler: async (req, res, requestRef) => {
        const id = (req.url ?? "").split("/").pop() ?? "";
        const removed = await ctx.sessions.removeSession(id);
        if (!removed) {
          sendJson(res, 404, { error: { type: "NOT_FOUND", message: "Session not found" } });
          return;
        }
        sendJson(res, 204, null);
      },
    },
    {
      method: "GET",
      path: "/bridge/auth-status",
      handler: async (_req, res) => {
        const status = await checkAuthStatus();
        sendJson(res, 200, status);
      },
    },
    {
      method: "POST",
      path: "/bridge/auth",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          // Check if auth already exists and is valid
          const status = await checkAuthStatus();
          if (status.valid) {
            send({ type: "result", step: "auth", ok: true, message: "Auth already configured: " + status.message });
            endSSE(res);
            return;
          }
          const auth = await runAuthSSE(send);
          if (auth) {
            await ctx.setRuntimeAuth?.(auth);
            send({ type: "result", step: "auth", ok: true, message: "Auth saved" });
          }
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/diagnostics",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          await runDiagnosticsSSE(send);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/doctor",
      handler: async (_req, res) => {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (e: ActionEvent) => writeSSE(res, e);
        try {
          await runDoctorSSE(send);
        } catch (error) {
          send({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
        endSSE(res);
      },
    },
    {
      method: "POST",
      path: "/bridge/launch",
      handler: async (req, res) => {
        try {
          const raw = await readBody({ raw: req }, ctx.security.maxBytes);
          const body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
          const tool = typeof body.tool === "string" ? body.tool : "";
          const workDir = typeof body.workDir === "string" ? body.workDir : process.cwd();
          const model = typeof body.model === "string" ? body.model : DEFAULT_MODEL_ID;
          const system = await (ctx.systemInfo?.() ?? getSystemCapabilities());

          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          const send = (e: ActionEvent) => writeSSE(res, e);

          if (tool === "claude") {
            if (!system.claudeCodeLaunch) {
              send({ type: "error", message: `Claude Code launch is not supported on ${system.platform} yet. Start it manually in a terminal.` });
              endSSE(res);
              return;
            }
            const launched = await launchClaudeCode(workDir, model, send);
            if (!launched) endSSE(res);
          } else if (tool === "opencode") {
            if (!system.openCodeLaunch) {
              send({ type: "error", message: `OpenCode launch is not supported on ${system.platform} yet. Start it manually in a terminal.` });
              endSSE(res);
              return;
            }
            const launched = await launchOpenCode(workDir, model, send);
            if (!launched) endSSE(res);
          } else {
            send({ type: "error", message: `Unknown tool: ${tool}. Use "claude" or "opencode".` });
            endSSE(res);
          }
        } catch (error) {
          sendJson(res, 500, { error: { type: "LAUNCH_ERROR", message: error instanceof Error ? error.message : String(error) } });
        }
      },
    },
    {
      method: "POST",
      path: "/bridge/pick-folder",
      handler: async (_req, res) => {
        const result = await pickFolder();
        if (!result.supported) {
          sendJson(res, 200, { path: null, message: "Folder picker not supported on this OS. Enter the path manually." });
        } else if (result.cancelled) {
          sendJson(res, 200, { path: null, cancelled: true });
        } else {
          sendJson(res, 200, { path: result.path });
        }
      },
    },
    {
      method: "POST",
      path: "/bridge/logout",
      handler: async (_req, res) => {
        try { await stopActiveAuthChrome(); } catch { /* logout remains local and best effort */ }
        const result = await performLogout();
        if (!result.ok) {
          sendJson(res, 500, result);
          return;
        }
        await ctx.clearRuntimeAuth?.();
        sendJson(res, 200, result);
      },
    },
    {
      method: "POST",
      path: "/bridge/shutdown",
      handler: async (_req, res) => {
        let started = false;
        const beginShutdown = () => {
          if (started) return;
          started = true;
          setImmediate(() => {
            void (ctx.gracefulStop?.() ?? Promise.resolve()).then(
              () => process.exit(0),
              () => process.exit(1),
            );
          });
        };
        res.once("finish", beginShutdown);
        res.once("close", beginShutdown);
        sendJson(res, 200, { ok: true, message: "Shutdown accepted." });
      },
    },
    {
      method: "GET",
      path: "/assets/*",
      handler: serveStaticAsset,
    },
    {
      method: "OPTIONS",
      path: "*",
      handler: async (req, res) => {
        const origin = req.headers.origin;
        const headers = corsHeaders(origin, ctx.security);
        res.writeHead(204, headers);
        res.end();
      },
    },
  ];
}

export function middlewareWrapper(ctx: RouteContext) {
  return (req: IncomingMessage, res: ServerResponse, requestRef: string): boolean => {
    try {
      const origin = req.headers.origin;
      if (origin && !corsAllowed(origin, ctx.security)) {
        sendJson(res, 403, { error: { type: "CORS_DENIED", message: "Origin not allowed" } });
        return false;
      }
      for (const [name, value] of Object.entries(corsHeaders(origin, ctx.security))) {
        res.setHeader(name, value);
      }
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      if (!isPublicPath(req.method ?? "GET", pathname)) {
        checkApiKey(req, ctx.security);
      }
      return true;
    } catch (error) {
      routeError(res, error, ctx, requestRef);
      return false;
    }
  };
}

export function errorStatus(error: unknown): number {
  if (error instanceof BridgeError) return error.status;
  return 500;
}
