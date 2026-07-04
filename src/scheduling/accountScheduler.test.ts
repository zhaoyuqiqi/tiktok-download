import { describe, expect, it } from "bun:test";
import { runAccountScheduler, type AccountJob } from "./accountScheduler.ts";

function createFakeTimer() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    get value() {
      return current;
    },
  };
}

describe("runAccountScheduler", () => {
  it("全局并发上限 + 同账号串行", async () => {
    const timer = createFakeTimer();
    let active = 0;
    let peak = 0;
    const accountActive = new Map<string, number>();

    const jobs: AccountJob[] = [
      {
        id: "a1",
        accountId: "alice",
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          accountActive.set("alice", (accountActive.get("alice") ?? 0) + 1);
          expect(accountActive.get("alice")).toBe(1);
          await timer.sleep(10);
          accountActive.set("alice", (accountActive.get("alice") ?? 1) - 1);
          active -= 1;
        },
      },
      {
        id: "a2",
        accountId: "alice",
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          accountActive.set("alice", (accountActive.get("alice") ?? 0) + 1);
          expect(accountActive.get("alice")).toBe(1);
          await timer.sleep(10);
          accountActive.set("alice", (accountActive.get("alice") ?? 1) - 1);
          active -= 1;
        },
      },
      {
        id: "b1",
        accountId: "bob",
        execute: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await timer.sleep(10);
          active -= 1;
        },
      },
    ];

    const summary = await runAccountScheduler(jobs, {
      concurrency: 2,
      sleep: timer.sleep,
      now: timer.now,
      prefetchDelayRangeMs: [0, 0],
      tickMs: 1,
    });

    expect(summary).toEqual({ total: 3, success: 3, failed: 0 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("指数退避重试且退避期间不占并发", async () => {
    const timer = createFakeTimer();
    const runAt: number[] = [];
    let unstableCount = 0;

    const jobs: AccountJob[] = [
      {
        id: "unstable",
        accountId: "alice",
        execute: async () => {
          runAt.push(timer.value);
          unstableCount += 1;
          if (unstableCount < 3) {
            throw new Error("boom");
          }
        },
      },
      {
        id: "stable",
        accountId: "bob",
        execute: async () => {
          runAt.push(timer.value);
        },
      },
    ];

    const summary = await runAccountScheduler(jobs, {
      concurrency: 2,
      maxAttempts: 3,
      backoffMs: [60, 180, 600],
      prefetchDelayRangeMs: [0, 0],
      sleep: timer.sleep,
      now: timer.now,
      tickMs: 1,
    });

    expect(summary).toEqual({ total: 2, success: 2, failed: 0 });
    expect(runAt).toHaveLength(4);
    expect(runAt[0]).toBe(runAt[1]); // stable 任务可在同一时刻并行执行，不被退避任务占住并发

    const firstBackoff = runAt[2]! - runAt[1]!;
    const secondBackoff = runAt[3]! - runAt[2]!;
    expect(firstBackoff).toBeGreaterThanOrEqual(60);
    expect(firstBackoff).toBeLessThan(70);
    expect(secondBackoff).toBeGreaterThanOrEqual(180);
    expect(secondBackoff).toBeLessThan(190);
  });

  it("每次抓取调用前都会注入随机延迟", async () => {
    const timer = createFakeTimer();
    const randomValues = [0, 1, 0.5];
    let randomIndex = 0;
    const starts: number[] = [];

    const jobs: AccountJob[] = [
      {
        id: "j1",
        accountId: "alice",
        execute: async () => {
          starts.push(timer.value);
        },
      },
      {
        id: "j2",
        accountId: "bob",
        execute: async () => {
          starts.push(timer.value);
        },
      },
      {
        id: "j3",
        accountId: "carol",
        execute: async () => {
          starts.push(timer.value);
        },
      },
    ];

    await runAccountScheduler(jobs, {
      concurrency: 1,
      prefetchDelayRangeMs: [2, 8],
      sleep: timer.sleep,
      now: timer.now,
      random: () => {
        const value = randomValues[randomIndex] ?? 0;
        randomIndex += 1;
        return value;
      },
      tickMs: 1,
    });

    expect(starts).toHaveLength(3);
    expect(starts[0]).toBeGreaterThanOrEqual(2);
    expect(starts[0]).toBeLessThanOrEqual(3);

    const secondDelay = starts[1]! - starts[0]!;
    const thirdDelay = starts[2]! - starts[1]!;
    expect(secondDelay).toBeGreaterThanOrEqual(8);
    expect(secondDelay).toBeLessThanOrEqual(12);
    expect(thirdDelay).toBeGreaterThanOrEqual(5);
    expect(thirdDelay).toBeLessThanOrEqual(8);
  });
});
