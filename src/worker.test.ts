import { test, expect } from "bun:test";
import { download } from "./worker.ts";
import type { ProcessResult, ProcessRunner, Task } from "./types.ts";

const task: Task = {
  id: "a",
  url: "https://tiktok.com/@u/video/a",
  status: "running",
  attempts: 0,
};

function runnerWith(result: ProcessResult, calls: string[][] = []): ProcessRunner {
  return {
    async run(args: string[]): Promise<ProcessResult> {
      calls.push(args);
      return result;
    },
  };
}

test("成功时取最后非空行作为 filePath", async () => {
  const stdout = "some log line\n/abs/output/a.mp4\n\n";
  const r = await download(runnerWith({ code: 0, stdout, stderr: "" }), task, "./output");
  expect(r.ok).toBe(true);
  expect(r.filePath).toBe("/abs/output/a.mp4");
});

test("透传 -P outputDir 与 --print after_move:filepath 与 url", async () => {
  const calls: string[][] = [];
  await download(
    runnerWith({ code: 0, stdout: "/abs/x.mp4", stderr: "" }, calls),
    task,
    "./output",
  );
  expect(calls[0]).toContain("-P");
  expect(calls[0]).toContain("./output");
  expect(calls[0]).toContain("--print");
  expect(calls[0]).toContain("after_move:filepath");
  expect(calls[0]).toContain(task.url);
});

test("指定 proxy 时透传 --proxy", async () => {
  const calls: string[][] = [];
  await download(
    runnerWith({ code: 0, stdout: "/abs/x.mp4", stderr: "" }, calls),
    task,
    "./output",
    "http://127.0.0.1:7890",
  );
  expect(calls[0]).toContain("--proxy");
  expect(calls[0]).toContain("http://127.0.0.1:7890");
});

test("未指定 proxy 时不传 --proxy", async () => {
  const calls: string[][] = [];
  await download(
    runnerWith({ code: 0, stdout: "/abs/x.mp4", stderr: "" }, calls),
    task,
    "./output",
  );
  expect(calls[0]).not.toContain("--proxy");
});

test("失败时返回 ok:false 与 stderr", async () => {
  const r = await download(
    runnerWith({ code: 1, stdout: "", stderr: "ERROR: boom" }),
    task,
    "./output",
  );
  expect(r.ok).toBe(false);
  expect(r.error).toBe("ERROR: boom");
});
