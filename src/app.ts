import fs from "node:fs";
import { buildConfig, isLoopbackHostAddress } from "./config/env.js";
import { FileSessionStorage } from "./auth/storage.js";
import { SessionManager } from "./auth/sessionManager.js";
import { PowSolver } from "./deepseek/pow.js";
import { DeepSeekClient } from "./deepseek/client.js";
import type { AuthCredentials } from "./deepseek/client.js";
import { CompletionHandler } from "./api/handler.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { LineageStore } from "./sessions/lineage.js";
import { PersistentSessionDocument } from "./sessions/persistentSessionDocument.js";
import { Redactor } from "./utils/redaction.js";
import { collectAuthSecrets } from "./utils/redaction.js";
import { Logger } from "./utils/logger.js";
import { isRecord } from "./utils/json.js";
import { BridgeServer } from "./server/server.js";
import type { RouteContext } from "./server/routes.js";
import { bridgeModelList } from "./config/modelCapabilities.js";
import { stopActiveAuthChrome, stopLaunchedProcesses } from "./server/actions.js";
import { BridgeError } from "./utils/errors.js";

export interface AppHandle {
  server: BridgeServer;
  sessionManager: SessionManager;
  init: () => Promise<void>;
  stop: () => Promise<void>;
}

interface AuthFileShape {
  token?: unknown;
  cookie?: unknown;
  hifDliq?: unknown;
  hifLeim?: unknown;
  hif_dliq?: unknown;
  hif_leim?: unknown;
}

export const ABSOLUTE_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownCoordinatorOptions {
  stopServer: () => Promise<void>;
  stopLaunched: () => Promise<void>;
  stopAuth: () => Promise<void>;
  logger?: Pick<Logger, "info" | "warn">;
  timeoutMs?: number;
}

function shutdownIncomplete(causeCode: string): BridgeError {
  return new BridgeError("Graceful shutdown did not complete.", {
    code: "SHUTDOWN_INCOMPLETE",
    status: 500,
    retryable: false,
    upstreamStage: "shutdown",
    causeCode,
  });
}

function startShutdownOperation(operation: () => Promise<void>): Promise<void> {
  try {
    return operation();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createShutdownCoordinator(options: ShutdownCoordinatorOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  return () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const timeoutMs = options.timeoutMs ?? ABSOLUTE_SHUTDOWN_TIMEOUT_MS;
      options.logger?.info("shutdown_start", { stage: "shutdown", timeout_ms: timeoutMs });
      const operations = Promise.allSettled([
        startShutdownOperation(options.stopServer),
        startShutdownOperation(options.stopLaunched),
        startShutdownOperation(options.stopAuth),
      ]);
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(shutdownIncomplete("shutdown_deadline")), timeoutMs);
      });

      let results: PromiseSettledResult<void>[];
      try {
        results = await Promise.race([operations, deadline]);
      } catch (error) {
        const failure = error instanceof BridgeError ? error : shutdownIncomplete("shutdown_deadline");
        options.logger?.warn("shutdown_incomplete", {
          stage: "shutdown",
          failure_class: failure.code,
          cause_code: failure.causeCode,
        });
        throw failure;
      } finally {
        if (timer) clearTimeout(timer);
      }

      const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (rejected) {
        const failure = rejected.reason instanceof BridgeError
          ? rejected.reason
          : shutdownIncomplete("shutdown_operation_failed");
        options.logger?.warn("shutdown_incomplete", {
          stage: "shutdown",
          failure_class: failure.code,
          cause_code: failure.causeCode,
        });
        throw failure;
      }
      options.logger?.info("shutdown_complete", { stage: "shutdown", outcome: "success" });
    })();
    return shutdownPromise;
  };
}

function loadAuthFile(file: string): AuthFileShape {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return isRecord(raw) ? (raw as AuthFileShape) : {};
  } catch {
    return {};
  }
}

export async function resetUpstreamAccountState(
  sessionStore: SessionStore,
  lineage: LineageStore,
): Promise<void> {
  sessionStore.clear();
  await lineage.clear();
}

export function buildApp(): AppHandle {
  const config = buildConfig();
  const redactor = new Redactor();
  const logger = new Logger({ level: config.debug ? "debug" : "info", redactor });

  const authData = loadAuthFile(config.authFile);
  const token = typeof authData.token === "string" ? authData.token : "";
  const cookie = typeof authData.cookie === "string" ? authData.cookie : "";
  const hifDliq = typeof authData.hifDliq === "string" ? authData.hifDliq
    : typeof authData.hif_dliq === "string" ? authData.hif_dliq : undefined;
  const hifLeim = typeof authData.hifLeim === "string" ? authData.hifLeim
    : typeof authData.hif_leim === "string" ? authData.hif_leim : undefined;

  for (const secret of collectAuthSecrets({ token, cookie, hif_dliq: hifDliq ?? "", hif_leim: hifLeim ?? "" })) {
    redactor.addSecret(secret);
  }

  const persistentSessions = new PersistentSessionDocument(config.sessionsFile);
  const sessionStorage = new FileSessionStorage(persistentSessions);
  const sessionManager = new SessionManager(sessionStorage, { logger });
  const sessionStore = new SessionStore();
  const lineage = new LineageStore(persistentSessions);
  let initialized = false;
  let initPromise: Promise<void> | null = null;
  const init = (): Promise<void> => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await persistentSessions.init();
      await sessionManager.init();
      await lineage.init();
      initialized = true;
    })();
    return initPromise;
  };

  const solver = new PowSolver({
    wasmCacheDir: config.dataDir,
    logger,
  });

  const deepseek = new DeepSeekClient({
    baseUrl: config.baseUrl,
    auth: token || cookie ? { token, cookie, hifDliq, hifLeim } : null,
    sessionManager,
    solver,
    logger,
    redactor,
    timeoutMs: config.timeoutMs,
    maxRetries: config.proxyApiKey ? 2 : 0,
  });

  const handler = new CompletionHandler({ deepseek, sessionStore, lineage, logger });

  const routeContext: RouteContext = {
    security: {
      proxyApiKey: config.proxyApiKey,
      corsOrigins: config.corsOrigins,
      maxBytes: config.maxBytes,
      loopback: isLoopbackHostAddress(config.host),
    },
    handler,
    sessions: sessionManager,
    logger,
    redactor,
    models: bridgeModelList(),
    ready: () => initialized,
    setRuntimeAuth: async (auth: AuthCredentials) => {
      await resetUpstreamAccountState(sessionStore, lineage);
      deepseek.setAuth(auth);
    },
    clearRuntimeAuth: async () => {
      deepseek.clearAuth();
      await resetUpstreamAccountState(sessionStore, lineage);
    },
  };

  const server = new BridgeServer({
    host: config.host,
    port: config.port,
    logger,
    routeContext,
    beforeStart: init,
  });

  const stop = createShutdownCoordinator({
    stopServer: () => server.stop(),
    stopLaunched: () => stopLaunchedProcesses({
      native: {
        onWarning: causeCode => logger.warn("shutdown_cleanup_warning", {
          stage: "shutdown_cleanup",
          cause_code: causeCode,
        }),
      },
    }),
    stopAuth: () => stopActiveAuthChrome(),
    logger,
  });

  routeContext.gracefulStop = stop;

  return {
    server,
    sessionManager,
    init,
    stop,
  };
}
