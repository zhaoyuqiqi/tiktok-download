import { test, expect } from "bun:test";
import { runScheduler } from "./scheduler.ts";
import { createTask, TaskQueue } from "./task.ts";
import type { DownloadResult, Task, Uploader, VideoInfo } from "./types.ts";

const v = (id: string): VideoInfo => ({ id, url: `https://x/${id}` });

function queueOf(ids: string[]): TaskQueue {
  return new TaskQueue(ids.map((id) => createTask(v(id))));
}

class CountingUploader implements Uploader {
  public calls: string[] = [];
  async upload(filePath: string): Promise<void> {
    this.calls.push(filePath);
  }
}

test("活跃下载数峰值不超过 workers", async () => {
  let active = 0;
  let peak = 0;
  const queue = queueOf(["a", "b", "c", "d", "e"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active -= 1;
    return { ok: true, filePath: `/out/${_t.id}.mp4` };
  };
  await runScheduler(queue, { workers: 2, retry: 2, retryDelayMs: 0 }, downloadFn, new CountingUploader());
  expect(peak).toBeLessThanOrEqual(2);
});

test("失败重试到上限后标 failed,不影响其他任务", async () => {
  const attemptsById: Record<string, number> = {};
  const queue = queueOf(["good", "bad"]);
  const downloadFn = async (t: Task): Promise<DownloadResult> => {
    attemptsById[t.id] = (attemptsById[t.id] ?? 0) + 1;
    if (t.id === "bad") return { ok: false, error: "boom" };
    return { ok: true, filePath: `/out/${t.id}.mp4` };
  };
  const summary = await runScheduler(
    queue,
    { workers: 2, retry: 2, retryDelayMs: 0 },
    downloadFn,
    new CountingUploader(),
  );
  expect(summary).toEqual({ success: 1, failed: 1, total: 2 });
  // bad: 首次 + 2 次重试 = 3 次尝试
  expect(attemptsById["bad"]).toBe(3);
  expect(attemptsById["good"]).toBe(1);
});

test("重试后成功最终标 success", async () => {
  let badCalls = 0;
  const queue = queueOf(["x"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => {
    badCalls += 1;
    if (badCalls < 2) return { ok: false, error: "transient" };
    return { ok: true, filePath: "/out/x.mp4" };
  };
  const summary = await runScheduler(
    queue,
    { workers: 1, retry: 2, retryDelayMs: 0 },
    downloadFn,
    new CountingUploader(),
  );
  expect(summary).toEqual({ success: 1, failed: 0, total: 1 });
});

test("下载成功触发 upload,且每个成功文件都被上传", async () => {
  const uploader = new CountingUploader();
  const queue = queueOf(["a", "b"]);
  const downloadFn = async (t: Task): Promise<DownloadResult> => ({
    ok: true,
    filePath: `/out/${t.id}.mp4`,
  });
  await runScheduler(queue, { workers: 2, retry: 2, retryDelayMs: 0 }, downloadFn, uploader);
  expect(uploader.calls.sort()).toEqual(["/out/a.mp4", "/out/b.mp4"]);
});

test("上传抛错不改下载 success 状态,且 in-flight 上传被等待收敛", async () => {
  let uploadStarted = 0;
  let uploadSettled = 0;
  const uploader: Uploader = {
    async upload(_filePath: string): Promise<void> {
      uploadStarted += 1;
      await Bun.sleep(5);
      uploadSettled += 1;
      throw new Error("upload failed");
    },
  };
  const queue = queueOf(["a"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => ({
    ok: true,
    filePath: "/out/a.mp4",
  });
  const summary = await runScheduler(
    queue,
    { workers: 1, retry: 2, retryDelayMs: 0 },
    downloadFn,
    uploader,
  );
  expect(summary).toEqual({ success: 1, failed: 0, total: 1 });
  // runScheduler 返回时,已触发的上传必须已收敛(即便它最终抛错)
  expect(uploadStarted).toBe(1);
  expect(uploadSettled).toBe(1);
});
