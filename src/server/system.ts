import fs from "node:fs";
import path from "node:path";

export type SupportedPlatform = "win32" | "darwin" | "linux";
export type LinuxFolderPicker = "zenity" | "kdialog";
export type LinuxTerminalEmulator =
  | "x-terminal-emulator"
  | "gnome-terminal"
  | "konsole"
  | "xfce4-terminal"
  | "kitty"
  | "xterm";

export interface SystemCapabilities {
  platform: SupportedPlatform;
  folderPicker: boolean;
  claudeCodeLaunch: boolean;
  openCodeLaunch: boolean;
}

export type CommandAvailability = (command: string) => Promise<boolean>;
export type PathAvailability = (target: string) => boolean;

export const MACOS_TERMINAL_APP_PATHS = [
  "/System/Applications/Utilities/Terminal.app",
  "/Applications/Utilities/Terminal.app",
] as const;

const LINUX_TERMINAL_EMULATORS: readonly LinuxTerminalEmulator[] = [
  "x-terminal-emulator",
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "kitty",
  "xterm",
];

export async function isCommandAvailable(command: string): Promise<boolean> {
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    try {
      await fs.promises.access(command, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const suffix = process.platform === "win32" && path.extname(command) ? "" : extension;
      try {
        await fs.promises.access(path.join(entry, `${command}${suffix}`), fs.constants.X_OK);
        return true;
      } catch { /* try the next candidate */ }
      if (!suffix) break;
    }
  }
  return false;
}

export function isCommandAvailableSync(command: string): boolean {
  if (path.isAbsolute(command) || command.includes(path.sep)) return fs.existsSync(command);
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const entry of pathValue.split(path.delimiter)) {
    if (!entry) continue;
    for (const extension of extensions) {
      const suffix = process.platform === "win32" && path.extname(command) ? "" : extension;
      if (fs.existsSync(path.join(entry, `${command}${suffix}`))) return true;
      if (!suffix) break;
    }
  }
  return false;
}

export async function findLinuxFolderPicker(
  commandAvailable: CommandAvailability = isCommandAvailable,
): Promise<LinuxFolderPicker | null> {
  if (await commandAvailable("zenity")) return "zenity";
  if (await commandAvailable("kdialog")) return "kdialog";
  return null;
}

export async function findLinuxTerminalEmulator(
  commandAvailable: CommandAvailability = isCommandAvailable,
): Promise<LinuxTerminalEmulator | null> {
  for (const terminal of LINUX_TERMINAL_EMULATORS) {
    if (await commandAvailable(terminal)) return terminal;
  }
  return null;
}

export async function isMacTerminalLaunchAvailable(
  commandAvailable: CommandAvailability = isCommandAvailable,
  pathAvailable: PathAvailability = fs.existsSync,
): Promise<boolean> {
  if (!(await commandAvailable("osascript"))) return false;
  return MACOS_TERMINAL_APP_PATHS.some(pathAvailable);
}

export async function getSystemCapabilities(
  platform: NodeJS.Platform = process.platform,
  commandAvailable: CommandAvailability = isCommandAvailable,
  pathAvailable: PathAvailability = fs.existsSync,
): Promise<SystemCapabilities> {
  if (platform === "win32") {
    return { platform, folderPicker: true, claudeCodeLaunch: true, openCodeLaunch: true };
  }
  if (platform === "darwin") {
    const osascriptAvailable = await commandAvailable("osascript");
    const terminalLaunch = osascriptAvailable && MACOS_TERMINAL_APP_PATHS.some(pathAvailable);
    return {
      platform,
      folderPicker: osascriptAvailable,
      claudeCodeLaunch: terminalLaunch,
      openCodeLaunch: terminalLaunch,
    };
  }
  if (platform === "linux") {
    const folderPicker = (await findLinuxFolderPicker(commandAvailable)) !== null;
    const terminalLaunch = (await findLinuxTerminalEmulator(commandAvailable)) !== null;
    return { platform, folderPicker, claudeCodeLaunch: terminalLaunch, openCodeLaunch: terminalLaunch };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}
