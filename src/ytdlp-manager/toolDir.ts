import { homedir } from "node:os";
import { basename, join } from "node:path";

const CURRENT_LINK_NAME = "current";
const CURRENT_SOURCE_LINK_NAME = "current-src";
const BIN_PREFIX = "yt-dlp-";
const SOURCE_PREFIX = "yt-dlp-src-";
const ENV_TOOL_DIR = "YT_DLP_TOOL_DIR";
const APP_NAME = "tiktok-downloader";

function defaultToolDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", APP_NAME, "yt-dlp");
  }

  if (process.platform === "win32") {
    const base =
      process.env.LOCALAPPDATA ??
      process.env.APPDATA ??
      join(homedir(), "AppData", "Local");

    return join(base, APP_NAME, "yt-dlp");
  }

  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");

  return join(base, APP_NAME, "yt-dlp");
}

export function resolveToolDir(rawToolDir?: string): string {
  if (rawToolDir !== undefined && rawToolDir.trim() !== "") {
    return rawToolDir;
  }

  const fromEnv = process.env[ENV_TOOL_DIR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }

  return defaultToolDir();
}

export function currentLinkPath(toolDir: string): string {
  return join(toolDir, CURRENT_LINK_NAME);
}

export function currentSourceLinkPath(toolDir: string): string {
  return join(toolDir, CURRENT_SOURCE_LINK_NAME);
}

export function parseVersionFromTarget(target: string): string | undefined {
  const base = basename(target);
  if (!base.startsWith(BIN_PREFIX)) {
    return undefined;
  }

  return base.slice(BIN_PREFIX.length) || undefined;
}

export function versionBinName(version: string): string {
  return `${BIN_PREFIX}${version}`;
}

export function versionSourceDirName(version: string): string {
  return `${SOURCE_PREFIX}${version}`;
}
