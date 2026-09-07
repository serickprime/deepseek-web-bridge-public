import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export interface ChromeLaunchOptions {
  profileDir: string;
  remoteDebugPort: number;
  chromePath?: string | null;
}

const DEFAULT_PORTS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome(explicit?: string | null): string | null {
  if (explicit && fs.existsSync(explicit)) return explicit;
  for (const candidate of DEFAULT_PORTS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function launchChrome(options: ChromeLaunchOptions): ChildProcess {
  const executable = findChrome(options.chromePath);
  if (!executable) {
    throw new Error(
      "Chrome not found. Set CHROME_PATH to the Chrome executable location.",
    );
  }
  fs.mkdirSync(options.profileDir, { recursive: true });
  const child = spawn(executable, [
    `--remote-debugging-port=${options.remoteDebugPort}`,
    `--user-data-dir=${options.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--restore-last-session",
    "about:blank",
  ], { stdio: "ignore", detached: false });
  return child;
}

export async function waitForDebugger(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Chrome not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Chrome DevTools did not become available on port ${port}.`);
}

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private readonly ws: WebSocket) {
    ws.onmessage = (event) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(String(event.data)) as CdpMessage;
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const resolver = this.pending.get(message.id);
        if (resolver) {
          this.pending.delete(message.id);
          resolver(message);
        }
        return;
      }
      if (message.method) {
        const callbacks = this.listeners.get(message.method) ?? [];
        for (const callback of callbacks) callback(message.params ?? {});
      }
    };
  }

  static async connect(debugUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(debugUrl);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Failed to open CDP websocket: ${debugUrl}`));
    });
    return new CdpConnection(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 60_000);
      this.pending.set(id, message => {
        clearTimeout(timer);
        if (message.error) {
          reject(new Error(`CDP ${method} failed: ${JSON.stringify(message.error)}`));
        } else {
          resolve(message.result ?? {});
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, callback: (params: Record<string, unknown>) => void): void {
    const callbacks = this.listeners.get(method) ?? [];
    callbacks.push(callback);
    this.listeners.set(method, callbacks);
  }

  close(): void {
    this.ws.close();
  }
}

export async function createPage(port: number): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?url=${encodeURIComponent("about:blank")}`, {
    method: "PUT",
  });
  if (!res.ok) throw new Error(`Failed to create a new tab (HTTP ${res.status}).`);
  const target = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!target.webSocketDebuggerUrl) {
    throw new Error("No websocket URL returned for the new tab.");
  }
  return target.webSocketDebuggerUrl;
}
