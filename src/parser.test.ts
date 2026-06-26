import { test, expect } from "bun:test";
import { parse } from "./parser.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

function fakeRunner(stdout: string, calls: string[][] = []): ProcessRunner {
  return {
    async run(args: string[]): Promise<ProcessResult> {
      calls.push(args);
      return { code: 0, stdout, stderr: "" };
    },
  };
}

test("解析单个视频返回 1 条", async () => {
  const json = JSON.stringify({
    id: "v1",
    webpage_url: "https://tiktok.com/@a/video/v1",
    title: "Hello",
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@a/video/v1");
  expect(videos).toHaveLength(1);
  expect(videos[0]).toEqual({
    id: "v1",
    url: "https://tiktok.com/@a/video/v1",
    title: "Hello",
  });
});

test("解析 playlist 展开 entries", async () => {
  const json = JSON.stringify({
    _type: "playlist",
    entries: [
      { id: "a", url: "https://tiktok.com/@u/video/a", title: "A" },
      { id: "b", url: "https://tiktok.com/@u/video/b", title: "B" },
    ],
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@u");
  expect(videos).toHaveLength(2);
  expect(videos.map((v) => v.id)).toEqual(["a", "b"]);
});

test("entry 缺 url 时用 id 兜底", async () => {
  const json = JSON.stringify({
    _type: "playlist",
    entries: [{ id: "onlyid" }],
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@u");
  expect(videos[0]!.url).toBe("onlyid");
});

test("limit 透传 -I :N 且不影响单视频", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u", 5);
  expect(calls[0]).toContain("-I");
  expect(calls[0]).toContain(":5");
});

test("无 limit 时不传 -I", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u");
  expect(calls[0]).not.toContain("-I");
});

test("指定 proxy 时透传 --proxy", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u", undefined, "http://127.0.0.1:7890");
  expect(calls[0]).toContain("--proxy");
  expect(calls[0]).toContain("http://127.0.0.1:7890");
});

test("未指定 proxy 时不传 --proxy", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u");
  expect(calls[0]).not.toContain("--proxy");
});

test("非法 JSON 抛错", async () => {
  const runner: ProcessRunner = {
    async run() {
      return { code: 0, stdout: "not-json", stderr: "" };
    },
  };
  await expect(parse(runner, "https://x")).rejects.toThrow();
});
