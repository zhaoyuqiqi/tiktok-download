import { describe, expect, it } from "bun:test";
import { DueScheduler } from "./dueScheduler.ts";

describe("DueScheduler", () => {
  it("tick 仅按并发剩余额度拉取 due 账号", async () => {
    const started: string[] = [];

    const scheduler = new DueScheduler({
      concurrency: 2,
      async listDueAccounts(limit) {
        expect(limit).toBe(2);
        return [
          { platform: "tiktok", accountId: "a" },
          { platform: "tiktok", accountId: "b" },
          { platform: "tiktok", accountId: "c" },
        ].slice(0, limit);
      },
      async runAccount(accountId) {
        started.push(accountId);
      },
    });

    await scheduler.tick();
    await Bun.sleep(0);

    expect(started.sort()).toEqual(["a", "b"]);
  });

  it("外部 trigger 与 due tick 共用同一 runAccount 流水线", async () => {
    const calls: Array<{ accountId: string; source: "due" | "manual"; limit?: number }> = [];
    let releaseManual!: () => void;
    const manualBlocker = new Promise<void>((resolve) => {
      releaseManual = resolve;
    });

    const scheduler = new DueScheduler({
      concurrency: 2,
      async listDueAccounts(limit) {
        expect(limit).toBe(1);
        return [{ platform: "tiktok", accountId: "due-account" }];
      },
      async runAccount(accountId, source, options) {
        calls.push({ accountId, source, limit: options?.limit });
        if (source === "manual") {
          await manualBlocker;
        }
      },
    });

    await scheduler.trigger("manual-account", { limit: 3 });
    await Bun.sleep(0);
    await scheduler.tick();
    await Bun.sleep(0);
    releaseManual();
    await Bun.sleep(0);

    expect(calls).toEqual([
      { accountId: "manual-account", source: "manual", limit: 3 },
      { accountId: "due-account", source: "due", limit: undefined },
    ]);
  });

  it("同账号并发触发时只运行一次", async () => {
    let runCount = 0;
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const scheduler = new DueScheduler({
      concurrency: 2,
      async listDueAccounts() {
        return [];
      },
      async runAccount() {
        runCount += 1;
        await blocker;
      },
    });

    await scheduler.trigger("same-account");
    await scheduler.trigger("same-account");
    await Bun.sleep(0);

    expect(runCount).toBe(1);
    release();
    await Bun.sleep(0);
  });

  it("manual 触发遵守全局并发上限，超额触发进入队列", async () => {
    const calls: Array<{ accountId: string; limit?: number }> = [];
    let releaseFirst!: () => void;
    const firstBlocker = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const scheduler = new DueScheduler({
      concurrency: 1,
      async listDueAccounts() {
        return [];
      },
      async runAccount(accountId, _source, options) {
        calls.push({ accountId, limit: options?.limit });
        if (accountId === "a") {
          await firstBlocker;
        }
      },
    });

    await scheduler.trigger("a", { limit: 3 });
    await scheduler.trigger("b", { limit: 2 });
    await Bun.sleep(0);

    expect(calls).toEqual([{ accountId: "a", limit: 3 }]);

    releaseFirst();
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(calls).toEqual([
      { accountId: "a", limit: 3 },
      { accountId: "b", limit: 2 },
    ]);
  });

  it("失败后按退避重试，且退避期间不占并发", async () => {
    const scheduled: Array<{ delay: number; callback: () => void }> = [];
    const calls: string[] = [];
    let unstableAttempts = 0;

    const scheduler = new DueScheduler({
      concurrency: 1,
      maxAttempts: 3,
      backoffMs: [60_000, 180_000, 600_000],
      setTimer(callback, delay) {
        scheduled.push({ delay, callback });
        return delay as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer() {},
      async listDueAccounts() {
        return [];
      },
      async runAccount(accountId, _source, options) {
        calls.push(`${accountId}:${options?.limit ?? "none"}`);
        if (accountId === "unstable") {
          unstableAttempts += 1;
          if (unstableAttempts === 1) {
            throw new Error("boom");
          }
        }
      },
    });

    await scheduler.trigger("unstable", { limit: 3 });
    await Bun.sleep(0);

    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delay).toBe(60_000);

    await scheduler.trigger("stable", { limit: 1 });
    await Bun.sleep(0);

    expect(calls).toEqual(["unstable:3", "stable:1"]);

    scheduled[0]?.callback();
    await Bun.sleep(0);

    expect(calls).toEqual(["unstable:3", "stable:1", "unstable:3"]);
  });
});
