import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema, openDatabase } from "../storage/db.ts";
import { StateRepository } from "../storage/repository.ts";
import { LocalWorker } from "./localWorker.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-local-worker-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "state.db"));
  initSchema(db);
  const repo = new StateRepository(db);
  return { db, repo };
}

describe("LocalWorker", () => {
  it("通过 claim 协议并发抽干任务并提交成功状态", async () => {
    const { repo } = setup();
    const tasks = ["a", "b", "c"].map(
      (accountId, index) =>
        repo.enqueueAccountTask({
          platform: "tiktok",
          accountId,
          source: "due",
          nowIso: `2026-07-26T10:00:0${index}.000Z`,
        }).task,
    );
    let active = 0;
    let maxActive = 0;
    const worker = new LocalWorker({
      repo,
      workerId: "local-test",
      concurrency: 2,
      async runTask(task) {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(5);
        active -= 1;
        return { accountId: task.accountId };
      },
    });

    worker.wake();
    await worker.waitForIdle();

    expect(maxActive).toBe(2);
    expect(tasks.map((task) => repo.getAccountTask(task.id)?.status)).toEqual([
      "SUCCESS",
      "SUCCESS",
      "SUCCESS",
    ]);
    expect(repo.getWorker("local-test")?.status).toBe("OFFLINE");
  });

  it("执行失败时记录可重试 FAILED，而不是错误地提交成功", async () => {
    const { repo } = setup();
    const created = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "broken",
      source: "manual",
      nowIso: new Date().toISOString(),
    });
    const worker = new LocalWorker({
      repo,
      workerId: "local-failure-test",
      concurrency: 1,
      async runTask() {
        throw new Error("boom");
      },
    });

    worker.wake();
    await worker.waitForIdle();

    const task = repo.getAccountTask(created.task.id);
    expect(task?.status).toBe("FAILED");
    expect(task?.lastError).toBe("boom");
    expect(task?.nextRetryAt).not.toBeNull();
  });
});
