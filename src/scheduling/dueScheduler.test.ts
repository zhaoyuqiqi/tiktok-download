import { describe, expect, it } from "bun:test";
import { DueScheduler, type DueSchedulerDeps } from "./dueScheduler.ts";

function createDeps(
  overrides: Partial<DueSchedulerDeps> = {},
): DueSchedulerDeps {
  return {
    discoveryLimit: 100,
    async listDueAccounts() {
      return [];
    },
    async enqueueAccountTask() {
      return { created: true };
    },
    recoverTasks() {
      return 0;
    },
    countClaimableTasks() {
      return 0;
    },
    countRunningTasks() {
      return 0;
    },
    wakeWorkers() {},
    now: () => new Date("2026-07-25T10:00:00.000Z"),
    ...overrides,
  };
}

describe("DueScheduler", () => {
  it("tick 将 due 账号创建为持久化任务后唤醒 worker", async () => {
    const enqueued: Array<{
      accountId: string;
      source: string;
      nowIso: string;
    }> = [];
    let wakeCount = 0;
    const scheduler = new DueScheduler(
      createDeps({
        discoveryLimit: 20,
        async listDueAccounts(limit, nowIso) {
          expect(limit).toBe(20);
          expect(nowIso).toBe("2026-07-25T10:00:00.000Z");
          return [
            { platform: "tiktok", accountId: "a" },
            { platform: "tiktok", accountId: "b" },
          ];
        },
        async enqueueAccountTask(accountId, source, _options, nowIso) {
          enqueued.push({ accountId, source, nowIso });
          return { created: true };
        },
        countClaimableTasks() {
          return 2;
        },
        wakeWorkers() {
          wakeCount += 1;
        },
      }),
    );

    await scheduler.tick();

    expect(enqueued).toEqual([
      { accountId: "a", source: "due", nowIso: "2026-07-25T10:00:00.000Z" },
      { accountId: "b", source: "due", nowIso: "2026-07-25T10:00:00.000Z" },
    ]);
    expect(wakeCount).toBe(1);
  });

  it("没有可领取任务时不唤醒 worker", async () => {
    let wakeCount = 0;
    const scheduler = new DueScheduler(
      createDeps({
        async listDueAccounts() {
          return [{ platform: "tiktok", accountId: "a" }];
        },
        async enqueueAccountTask() {
          return { created: false };
        },
        wakeWorkers() {
          wakeCount += 1;
        },
      }),
    );

    await scheduler.tick();
    expect(wakeCount).toBe(0);
  });

  it("tick 会恢复到期租约并唤醒已有任务", async () => {
    let recoveredAt = "";
    let wakeCount = 0;
    const scheduler = new DueScheduler(
      createDeps({
        recoverTasks(nowIso) {
          recoveredAt = nowIso;
          return 1;
        },
        countClaimableTasks() {
          return 1;
        },
        wakeWorkers() {
          wakeCount += 1;
        },
      }),
    );

    await scheduler.tick();
    expect(recoveredAt).toBe("2026-07-25T10:00:00.000Z");
    expect(wakeCount).toBe(1);
  });

  it("manual trigger 持久化全部参数并立即唤醒", async () => {
    let received: unknown;
    let wakeCount = 0;
    const scheduler = new DueScheduler(
      createDeps({
        async enqueueAccountTask(accountId, source, options, nowIso) {
          received = { accountId, source, options, nowIso };
          return { created: true };
        },
        wakeWorkers() {
          wakeCount += 1;
        },
      }),
    );

    await scheduler.trigger("manual-account", {
      limit: 3,
      categoryId: 7,
      zhName: "测试",
    });

    expect(received).toEqual({
      accountId: "manual-account",
      source: "manual",
      options: { limit: 3, categoryId: 7, zhName: "测试" },
      nowIso: "2026-07-25T10:00:00.000Z",
    });
    expect(wakeCount).toBe(1);
  });

  it("runningCount 来自持久化任务统计", () => {
    const scheduler = new DueScheduler(
      createDeps({ countRunningTasks: () => 2 }),
    );
    expect(scheduler.runningCount).toBe(2);
  });

  it("worker 唤醒失败时保留已入队任务且 trigger 不抛错", async () => {
    let enqueueCount = 0;
    const scheduler = new DueScheduler(
      createDeps({
        async enqueueAccountTask() {
          enqueueCount += 1;
          return { created: true };
        },
        wakeWorkers() {
          throw new Error("dispatch unavailable");
        },
      }),
    );

    await expect(scheduler.trigger("alice")).resolves.toBeUndefined();
    expect(enqueueCount).toBe(1);
  });
});
