import { test, expect } from "bun:test";
import { parseArgs } from "./index.ts";

test("默认值:workers=2 retry=2 outputDir=./output limit 未定义", () => {
  const cfg = parseArgs(["https://tiktok.com/@u/video/1"]);
  expect(cfg.url).toBe("https://tiktok.com/@u/video/1");
  expect(cfg.workers).toBe(2);
  expect(cfg.retry).toBe(2);
  expect(cfg.outputDir).toBe("./output");
  expect(cfg.limit).toBeUndefined();
});

test("解析 --limit --workers --retry -o", () => {
  const cfg = parseArgs([
    "https://tiktok.com/@u",
    "--limit",
    "5",
    "--workers",
    "3",
    "--retry",
    "4",
    "-o",
    "./videos",
  ]);
  expect(cfg.url).toBe("https://tiktok.com/@u");
  expect(cfg.limit).toBe(5);
  expect(cfg.workers).toBe(3);
  expect(cfg.retry).toBe(4);
  expect(cfg.outputDir).toBe("./videos");
});

test("解析 --proxy", () => {
  const cfg = parseArgs(["https://tiktok.com/@u/video/1", "--proxy", "http://127.0.0.1:7890"]);
  expect(cfg.proxy).toBe("http://127.0.0.1:7890");
});

test("默认无 proxy", () => {
  const cfg = parseArgs(["https://tiktok.com/@u/video/1"]);
  expect(cfg.proxy).toBeUndefined();
});

test("缺少 url 抛错", () => {
  expect(() => parseArgs([])).toThrow();
});

test("--workers 非数值抛错", () => {
  expect(() => parseArgs(["https://x", "--workers", "abc"])).toThrow();
});

test("--retry 缺值抛错", () => {
  expect(() => parseArgs(["https://x", "--retry"])).toThrow();
});

test("--limit 非数值抛错", () => {
  expect(() => parseArgs(["https://x", "--limit", "xx"])).toThrow();
});
