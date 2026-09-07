import { spawn } from "node:child_process";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BRIDGE_URL = "http://127.0.0.1:9655";
export const HEALTH_URL = `${BRIDGE_URL}/health`;
export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";
export const MINIMUM_NODE_MAJOR = 20;
export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export class DesktopStartError extends Error {
  constructor(userMessage, technicalMessage = "") {
    super(userMessage);
    this.name = "DesktopStartError";
    this.userMessage = userMessage;
    this.technicalMessage = technicalMessage;
  }
}

export function parseNodeMajor(version) {
  const match = String(version ?? "").trim().match(/^v?(\d+)(?:\.|$)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isSupportedNodeVersion(version) {
  const major = parseNodeMajor(version);
  return major !== null && major >= MINIMUM_NODE_MAJOR;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function newestSourceMtime(directory) {
  let newest = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestSourceMtime(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      newest = Math.max(newest, (await stat(entryPath)).mtimeMs);
    }
  }
  return newest;
}

export async function needsBuild(projectRoot = PROJECT_ROOT) {
  const outputPath = path.join(projectRoot, "dist", "index.js");
  if (!await exists(outputPath)) return true;

  const outputMtime = (await stat(outputPath)).mtimeMs;
  const sourceMtime = await newestSourceMtime(path.join(projectRoot, "src"));
  const configPaths = ["package.json", "tsconfig.json", "tsconfig.build.json"]
    .map(name => path.join(projectRoot, name));
  let inputMtime = sourceMtime;
  for (const configPath of configPaths) {
    inputMtime = Math.max(inputMtime, (await stat(configPath)).mtimeMs);
  }
  return inputMtime > outputMtime;
}

function npmSpawnOptions(cwd, stdio) {
  return {
    cwd,
    stdio,
    windowsHide: false,
    shell: false,
  };
}

function npmInvocation(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }
  return { command: "npm", args };
}

function runNpm(args, cwd, stdio = "inherit") {
  return new Promise(resolve => {
    const invocation = npmInvocation(args);
    const child = spawn(invocation.command, invocation.args, npmSpawnOptions(cwd, stdio));
    let spawnError = null;
    child.once("error", error => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, error: spawnError });
    });
  });
}

function startBridge(cwd) {
  const invocation = npmInvocation(["start"]);
  const child = spawn(invocation.command, invocation.args, npmSpawnOptions(cwd, "inherit"));
  let exitResult = null;
  const exited = new Promise(resolve => {
    child.once("error", error => {
      exitResult = { code: null, signal: null, error };
      resolve(exitResult);
    });
    child.once("exit", (code, signal) => {
      if (exitResult) return;
      exitResult = { code, signal, error: null };
      resolve(exitResult);
    });
  });
  return { child, exited, getExitResult: () => exitResult };
}

async function checkHealth(url = HEALTH_URL) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status === 200;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForBridgeHealth({
  check = checkHealth,
  getExitResult = () => null,
  wait = sleep,
  timeoutMs = 45_000,
  intervalMs = 500,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  do {
    if (await check()) return;
    const exitResult = getExitResult();
    if (exitResult) {
      const detail = exitResult.error?.message
        ?? `npm start завершился с кодом ${String(exitResult.code)}${exitResult.signal ? ` (${exitResult.signal})` : ""}`;
      throw new DesktopStartError("Не удалось запустить DeepSeek Web Bridge.", detail);
    }
    await wait(intervalMs);
  } while (now() < deadline);

  throw new DesktopStartError(
    "Не удалось запустить DeepSeek Web Bridge.",
    `Сервер не ответил на ${HEALTH_URL} за ${Math.round(timeoutMs / 1_000)} секунд.`,
  );
}

function browserCommands(url) {
  if (process.platform === "win32") {
    return [[process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "start", "", url]]];
  }
  if (process.platform === "darwin") return [["open", [url]]];
  return [["xdg-open", [url]], ["gio", ["open", url]]];
}

function spawnDetached(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

async function openUrl(url) {
  for (const [command, args] of browserCommands(url)) {
    if (await spawnDetached(command, args)) return true;
  }
  return false;
}

async function npmVersion(projectRoot) {
  const result = await runNpm(["--version"], projectRoot, "ignore");
  return result.code === 0 ? "available" : null;
}

export function createDefaultRuntime() {
  return {
    nodeVersion: process.versions.node,
    pathExists: exists,
    needsBuild,
    npmVersion,
    runNpm,
    checkHealth,
    startBridge,
    waitForBridgeHealth,
    openUrl,
    log: message => console.log(message),
  };
}

function commandFailureDetail(command, result) {
  if (result.error) return `${command}: ${result.error.message}`;
  return `${command} завершился с кодом ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`;
}

async function openWebUi(runtime) {
  if (!await runtime.openUrl(BRIDGE_URL)) {
    runtime.log(`Не удалось автоматически открыть браузер. Откройте вручную: ${BRIDGE_URL}`);
  }
}

export async function runDesktopStart({
  projectRoot = PROJECT_ROOT,
  runtime: overrides = {},
  keepAlive = true,
} = {}) {
  const runtime = { ...createDefaultRuntime(), ...overrides };

  if (!isSupportedNodeVersion(runtime.nodeVersion)) {
    await runtime.openUrl(NODE_DOWNLOAD_URL);
    throw new DesktopStartError(
      "Для запуска нужен Node.js 20 или новее.",
      runtime.nodeVersion ? `Обнаружена версия Node.js ${runtime.nodeVersion}.` : "Node.js не найден.",
    );
  }

  if (!await runtime.npmVersion(projectRoot)) {
    throw new DesktopStartError(
      "Не найден npm. Установите Node.js 20 или новее с официального сайта.",
      "Команда npm --version завершилась с ошибкой.",
    );
  }

  if (await runtime.checkHealth(HEALTH_URL)) {
    runtime.log("DeepSeek Web Bridge уже запущен. Открываю Web UI...");
    await openWebUi(runtime);
    return { alreadyRunning: true, installed: false, built: false };
  }

  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const firstRun = !await runtime.pathExists(nodeModulesPath);
  if (firstRun) {
    runtime.log("Первый запуск. Устанавливаю необходимые компоненты. Это может занять несколько минут...");
    const installResult = await runtime.runNpm(["install"], projectRoot);
    if (installResult.code !== 0) {
      throw new DesktopStartError(
        "Не удалось установить необходимые компоненты.",
        commandFailureDetail("npm install", installResult),
      );
    }
  }

  const buildRequired = firstRun || await runtime.needsBuild(projectRoot);
  if (buildRequired) {
    runtime.log("Подготавливаю DeepSeek Web Bridge...");
    const buildResult = await runtime.runNpm(["run", "build"], projectRoot);
    if (buildResult.code !== 0) {
      throw new DesktopStartError(
        "Не удалось подготовить DeepSeek Web Bridge.",
        commandFailureDetail("npm run build", buildResult),
      );
    }
  }

  runtime.log("Запускаю DeepSeek Web Bridge...");
  let started;
  try {
    started = runtime.startBridge(projectRoot);
  } catch (error) {
    throw new DesktopStartError(
      "Не удалось запустить DeepSeek Web Bridge.",
      error instanceof Error ? error.message : String(error),
    );
  }

  await runtime.waitForBridgeHealth({
    check: () => runtime.checkHealth(HEALTH_URL),
    getExitResult: started.getExitResult,
  });
  runtime.log("DeepSeek Web Bridge готов. Открываю Web UI...");
  await openWebUi(runtime);

  if (keepAlive) {
    const exitResult = await started.exited;
    if (exitResult.error || (exitResult.code !== 0 && exitResult.code !== null)) {
      throw new DesktopStartError(
        "DeepSeek Web Bridge неожиданно остановился.",
        commandFailureDetail("npm start", exitResult),
      );
    }
  }

  return { alreadyRunning: false, installed: firstRun, built: buildRequired };
}

function printError(error) {
  const userMessage = error instanceof DesktopStartError
    ? error.userMessage
    : "Не удалось запустить DeepSeek Web Bridge.";
  const technicalMessage = error instanceof DesktopStartError
    ? error.technicalMessage
    : error instanceof Error ? error.message : String(error);
  console.error(`\n${userMessage}`);
  if (technicalMessage) console.error(`\nТехническая информация:\n${technicalMessage}`);
}

const directEntry = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (directEntry) {
  runDesktopStart().catch(error => {
    printError(error);
    process.exitCode = 1;
  });
}
