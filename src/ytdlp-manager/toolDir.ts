import { basename, join } from "node:path";

const CURRENT_LINK_NAME = "current";
const BIN_PREFIX = "yt-dlp-";
const ENV_TOOL_DIR = "YT_DLP_TOOL_DIR";

export function resolveToolDir(rawToolDir?: string): string {
  if (rawToolDir !== undefined && rawToolDir.trim() !== "") {
    return rawToolDir;
  }

  const fromEnv = process.env[ENV_TOOL_DIR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }

  return process.platform === "win32" ? "C:\\opt\\yt-dlp" : "/opt/yt-dlp";
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
