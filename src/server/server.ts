import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { REQUEST_REF_LENGTH } from "../config/constants.js";
import { randomToken } from "../utils/crypto.js";
import { BridgeError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";
import { routes, middlewareWrapper, type RouteContext } from "./routes.js";

export interface ServerOptions {
  host: string;
  port: number;
  logger: Logger;
  routeContext: RouteContext;
  beforeStart?: () => Promise<void>;
}

export class BridgeServer {
  private readonly server: http.Server;
  private readonly logger: Logger;

  constructor(private readonly options: ServerOptions) {
    this.logger = options.logger;
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const requestRef = randomToken(REQUEST_REF_LENGTH);
    const logger = this.logger.withRequestRef(requestRef);
    res.setHeader("x-request-ref", requestRef);

    const url = req.url ?? "/";
    const pathname = url.split("?")[0] ?? "/";
    const method = req.method ?? "GET";
    const routeTable = routes(this.options.routeContext);

    logger.info("request_start", { method, path: pathname });

    if (!middlewareWrapper(this.options.routeContext)(req, res, requestRef)) {
      logger.info("request_rejected", { method, path: pathname });
      return;
    }

    const route = routeTable.find(
      r => (r.method === method || r.method === "OPTIONS") && this.matchPath(r.path, pathname),
    );
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "NOT_FOUND", message: `No route for ${method} ${pathname}` } }));
      logger.info("request_404", { method, path: pathname });
      return;
    }

    route
      .handler(req, res, requestRef)
      .then(() => {
        if (!res.writableEnded) res.end();
      })
      .catch(error => {
        const bridgeError = error instanceof BridgeError ? error : undefined;
        logger.error("request_failed", {
          method,
          route: pathname,
          stage: bridgeError?.upstreamStage ?? "server_route",
          outcome: "failure",
          failure_class: bridgeError?.code ?? "UNHANDLED_ERROR",
          cause_code: bridgeError?.causeCode ?? "unhandled_error",
          retryable: bridgeError?.retryable ?? false,
        });
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { type: "INTERNAL_ERROR", message: "Internal server error" } }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  }

  private matchPath(pattern: string, pathname: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2);
      return pathname === prefix || pathname.startsWith(prefix + "/");
    }
    if (pattern.includes(":id")) {
      const patternSegments = pattern.split("/");
      const pathSegments = pathname.split("/");
      if (patternSegments.length !== pathSegments.length) return false;
      for (let i = 0; i < patternSegments.length; i++) {
        const ps = patternSegments[i];
        const xs = pathSegments[i];
        if (!ps || !xs) return false;
        if (ps.startsWith(":") && xs) continue;
        if (ps !== xs) return false;
      }
      return true;
    }
    return pattern === pathname;
  }

  async start(): Promise<void> {
    await this.options.beforeStart?.();
    const { host, port } = this.options;
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    this.logger.info("server_listening", { host, port });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
    this.logger.info("server_stopped");
  }
}
