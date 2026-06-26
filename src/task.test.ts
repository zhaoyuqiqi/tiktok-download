import { test, expect } from "bun:test";
import { createTask, TaskQueue } from "./task.ts";
import type { VideoInfo } from "./types.ts";

const v = (id: string): VideoInfo => ({ id, url: `https://x/${id}` });

test("createTask 初始状态 pending/attempts 0", () => {
  const t = createTask(v("a"));
  expect(t.status).toBe("pending");
  expect(t.attempts).toBe(0);
  expect(t.id).toBe("a");
  expect(t.url).toBe("https://x/a");
});

test("next 按顺序返回 pending 并置 running", () => {
  const q = new TaskQueue([createTask(v("a")), createTask(v("b"))]);
  const t1 = q.next();
  expect(t1!.id).toBe("a");
  expect(t1!.status).toBe("running");
  const t2 = q.next();
  expect(t2!.id).toBe("b");
  expect(q.next()).toBeUndefined();
});

test("requeue 让任务可被再次取出且 attempts 递增", () => {
  const q = new TaskQueue([createTask(v("a"))]);
  const t = q.next()!;
  q.requeue(t);
  expect(t.attempts).toBe(1);
  expect(t.status).toBe("pending");
  const again = q.next();
  expect(again!.id).toBe("a");
});

test("summary 统计 success/failed/total", () => {
  const q = new TaskQueue([createTask(v("a")), createTask(v("b")), createTask(v("c"))]);
  const a = q.next()!;
  const b = q.next()!;
  const c = q.next()!;
  q.markSuccess(a);
  q.markSuccess(b);
  q.markFailed(c);
  expect(q.summary()).toEqual({ success: 2, failed: 1, total: 3 });
});
