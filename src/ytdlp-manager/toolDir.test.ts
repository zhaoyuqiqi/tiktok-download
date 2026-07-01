import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  currentLinkPath,
  parseVersionFromTarget,
  resolveToolDir,
  versionBinName,
} from "./toolDir.ts";

const ENV_KEY = "YT_DLP_TOOL_DIR";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});

test("resolveToolDir 显式参数优先", () => {
  expect(resolveToolDir("/custom/tool/dir")).toBe("/custom/tool/dir");
});

test("resolveToolDir 环境变量覆盖默认值", () => {
  process.env[ENV_KEY] = "/env/tool/dir";
  expect(resolveToolDir()).toBe("/env/tool/dir");
});

test("resolveToolDir 空白参数回退到环境变量/默认", () => {
  process.env[ENV_KEY] = "/env/tool/dir";
  expect(resolveToolDir("   ")).toBe("/env/tool/dir");
});

test("resolveToolDir 无参数无环境变量时按平台给默认值", () => {
  const expected =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support", "tiktok-downloader", "yt-dlp")
      : process.platform === "win32"
        ? join(
            process.env.LOCALAPPDATA ?? process.env.APPDATA ?? join(homedir(), "AppData", "Local"),
            "tiktok-downloader",
            "yt-dlp",
          )
        : join(
            process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
            "tiktok-downloader",
            "yt-dlp",
          );

  expect(resolveToolDir()).toBe(expected);
});

test("currentLinkPath 拼出 <toolDir>/current", () => {
  expect(currentLinkPath("/opt/yt-dlp")).toBe(join("/opt/yt-dlp", "current"));
});

test("parseVersionFromTarget 解析出版本", () => {
  expect(parseVersionFromTarget("yt-dlp-2026.06.28")).toBe("2026.06.28");
  expect(parseVersionFromTarget("/opt/yt-dlp/yt-dlp-2026.06.28")).toBe("2026.06.28");
});

test("parseVersionFromTarget 非法名返回 undefined", () => {
  expect(parseVersionFromTarget("current")).toBeUndefined();
  expect(parseVersionFromTarget("yt-dlp-")).toBeUndefined();
});

test("versionBinName 生成二进制名", () => {
  expect(versionBinName("2026.06.28")).toBe("yt-dlp-2026.06.28");
});
