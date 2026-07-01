import { homedir } from "node:os";
import { basename, join } from "node:path";

const CURRENT_LINK_NAME = "current";
const BIN_PREFIX = "yt-dlp-";
const ENV_TOOL_DIR = "YT_DLP_TOOL_DIR";

function defaultToolDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "tiktok-downloader", "yt-dlp");
  }

  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? "C:\\Users\\Default\\AppData\\Local", "tiktok-downloader", "yt-dlp");
  }

  return join(homedir(), ".local", "share", "tiktok-downloader", "yt-dlp");
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
