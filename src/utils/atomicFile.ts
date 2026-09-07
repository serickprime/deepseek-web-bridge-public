import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function tempSiblingPath(file: string): string {
  return `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
}

function backupSiblingPath(file: string): string {
  return `${file}.bak`;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP") throw error;
    }
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await fs.promises.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Directory fsync is not supported by every filesystem.
  }
}

async function recoverBackup(file: string): Promise<void> {
  const backup = backupSiblingPath(file);
  if (!(await pathExists(backup))) return;
  if (await pathExists(file)) {
    await fs.promises.unlink(backup).catch(() => undefined);
    return;
  }
  try {
    await fs.promises.rename(backup, file);
  } catch {
    await fs.promises.copyFile(backup, file);
    await fs.promises.unlink(backup).catch(() => undefined);
  }
}

async function replaceWithRecoverableBackup(temp: string, file: string): Promise<void> {
  const backup = backupSiblingPath(file);
  await recoverBackup(file);
  await fs.promises.unlink(backup).catch(() => undefined);

  let previousMoved = false;
  try {
    await fs.promises.rename(file, backup);
    previousMoved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    await fs.promises.rename(temp, file);
  } catch (error) {
    if (previousMoved) {
      try {
        await fs.promises.rename(backup, file);
      } catch {
        await fs.promises.copyFile(backup, file);
      }
    }
    throw error;
  }

  if (previousMoved) {
    await fs.promises.unlink(backup).catch(() => undefined);
  }
}

export async function writeJsonAtomic(file: string, data: unknown, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  await recoverBackup(file);
  const temp = tempSiblingPath(file);
  const body = JSON.stringify(data, null, 2);
  const isWin = process.platform === "win32";
  const writeOpts: fs.WriteFileOptions = isWin
    ? { encoding: "utf8" }
    : { encoding: "utf8", mode };
  try {
    await fs.promises.writeFile(temp, body, writeOpts);
    await syncFile(temp);
    try {
      await fs.promises.rename(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" ||
          (error as NodeJS.ErrnoException).code === "EPERM") {
        await replaceWithRecoverableBackup(temp, file);
      } else {
        throw error;
      }
    }
    if (!isWin && mode !== undefined) {
      await fs.promises.chmod(file, mode).catch(() => undefined);
    }
    await syncDirectory(dir);
  } finally {
    await fs.promises.unlink(temp).catch(() => undefined);
  }
}

export interface StrictJsonReadResult {
  exists: boolean;
  value: unknown;
}

export async function readJsonStrictIfExists(file: string): Promise<StrictJsonReadResult> {
  await recoverBackup(file);
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    return { exists: true, value: JSON.parse(raw) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, value: null };
    }
    throw error;
  }
}

export async function readJsonIfExists(file: string): Promise<unknown> {
  try {
    const result = await readJsonStrictIfExists(file);
    return result.exists ? result.value : null;
  } catch {
    return null;
  }
}

export function fileMode(file: string): number | null {
  try {
    const stat = fs.statSync(file);
    return stat.mode & 0o777;
  } catch {
    return null;
  }
}

export function isOwnerOnlyMode(mode: number | null): boolean {
  return mode !== null && (mode & 0o077) === 0;
}
