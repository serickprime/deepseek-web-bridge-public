import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
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
export function findChrome(explicit) {
    if (explicit && fs.existsSync(explicit))
        return explicit;
    for (const candidate of DEFAULT_PORTS) {
        if (candidate && fs.existsSync(candidate))
            return candidate;
    }
    return null;
}
export function launchChrome(options) {
    const executable = findChrome(options.chromePath);
    if (!executable) {
        throw new Error("Chrome not found. Set CHROME_PATH to the Chrome executable location.");
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
export async function waitForDebugger(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (res.ok)
                return;
        }
        catch {
            // Chrome not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`Chrome DevTools did not become available on port ${port}.`);
}
export class CdpConnection {
    ws;
    nextId = 1;
    pending = new Map();
    listeners = new Map();
    constructor(ws) {
        this.ws = ws;
        ws.onmessage = (event) => {
            let message;
            try {
                message = JSON.parse(String(event.data));
            }
            catch {
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
                for (const callback of callbacks)
                    callback(message.params ?? {});
            }
        };
    }
    static async connect(debugUrl) {
        const ws = new WebSocket(debugUrl);
        await new Promise((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error(`Failed to open CDP websocket: ${debugUrl}`));
        });
        return new CdpConnection(ws);
    }
    send(method, params = {}) {
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
                }
                else {
                    resolve(message.result ?? {});
                }
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    on(method, callback) {
        const callbacks = this.listeners.get(method) ?? [];
        callbacks.push(callback);
        this.listeners.set(method, callbacks);
    }
    close() {
        this.ws.close();
    }
}
export async function createPage(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?url=${encodeURIComponent("about:blank")}`, {
        method: "PUT",
    });
    if (!res.ok)
        throw new Error(`Failed to create a new tab (HTTP ${res.status}).`);
    const target = (await res.json());
    if (!target.webSocketDebuggerUrl) {
        throw new Error("No websocket URL returned for the new tab.");
    }
    return target.webSocketDebuggerUrl;
}
//# sourceMappingURL=cdp.js.map