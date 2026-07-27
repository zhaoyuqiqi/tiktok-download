import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema, openDatabase } from "./db.ts";
import { StateRepository } from "./repository.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-task-repo-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "state.db"));
  initSchema(db);
  return { db, repo: new StateRepository(db) };
}

describe("StateRepository account tasks", () => {
  it("同账号任务去重，manual 可提升尚未运行的 due 任务并持久化参数", () => {
    const { repo } = createRepo();
    const first = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "due",
      nowIso: "2026-07-26T10:00:00.000Z",
    });
    const duplicate = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "due",
      nowIso: "2026-07-26T10:00:01.000Z",
    });
    const manual = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "manual",
      options: { limit: 3, categoryId: 7, zhName: "爱丽丝" },
      nowIso: "2026-07-26T10:00:02.000Z",
    });

    expect(first.created).toBeTrue();
    expect(duplicate.created).toBeFalse();
    expect(duplicate.task.id).toBe(first.task.id);
    expect(manual.created).toBeFalse();
    expect(manual.task.source).toBe("manual");
    expect(manual.task.options).toEqual({
      limit: 3,
      categoryId: 7,
      zhName: "爱丽丝",
    });
  });

  it("多个 worker 竞争时只允许一个领取，并遵守全局并发", () => {
    const { repo } = createRepo();
    repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "due",
      nowIso: "2026-07-26T10:00:00.000Z",
    });
    repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "bob",
      source: "due",
      nowIso: "2026-07-26T10:00:01.000Z",
    });

    const first = repo.claimAccountTask({
      workerId: "worker-a",
      nowIso: "2026-07-26T10:01:00.000Z",
      leaseSeconds: 300,
      concurrency: 1,
    });
    const blocked = repo.claimAccountTask({
      workerId: "worker-b",
      nowIso: "2026-07-26T10:01:00.000Z",
      leaseSeconds: 300,
      concurrency: 1,
    });

    expect(first?.accountId).toBe("alice");
    expect(blocked).toBeNull();
    expect(repo.countRunningAccountTasks()).toBe(1);
    expect(repo.countClaimableAccountTasks()).toBe(1);
  });

  it("heartbeat 延长租约，租约过期后任务可由其他 worker 重领", () => {
    const { repo } = createRepo();
    const created = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "due",
      nowIso: "2026-07-26T10:00:00.000Z",
    });
    const first = repo.claimAccountTask({
      workerId: "worker-a",
      nowIso: "2026-07-26T10:00:00.000Z",
      leaseSeconds: 300,
      concurrency: 2,
    });
    expect(first).not.toBeNull();

    const heartbeat = repo.heartbeatAccountTask(
      {
        taskId: created.task.id,
        workerId: "worker-a",
        leaseToken: first!.leaseToken,
        nowIso: "2026-07-26T10:04:00.000Z",
      },
      300,
    );
    expect(heartbeat?.leaseExpiresAt).toBe("2026-07-26T10:09:00.000Z");
    expect(repo.recoverAccountTasks("2026-07-26T10:08:00.000Z")).toBe(0);
    expect(repo.recoverAccountTasks("2026-07-26T10:10:00.000Z")).toBe(1);

    const second = repo.claimAccountTask({
      workerId: "worker-b",
      nowIso: "2026-07-26T10:10:00.000Z",
      leaseSeconds: 300,
      concurrency: 2,
    });
    expect(second?.id).toBe(created.task.id);
    expect(second?.workerId).toBe("worker-b");
    expect(second?.leaseToken).not.toBe(first?.leaseToken);
  });

  it("失败任务按退避重试，耗尽重试后允许创建下一轮任务", () => {
    const { repo } = createRepo();
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "alice",
      nextRunAt: "2026-07-26T09:00:00.000Z",
    });
    const created = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "due",
      nowIso: "2026-07-26T10:00:00.000Z",
      maxRetries: 1,
    });
    const first = repo.claimAccountTask({
      workerId: "worker-a",
      nowIso: "2026-07-26T10:00:00.000Z",
      leaseSeconds: 300,
      concurrency: 1,
    })!;
    const retryable = repo.failAccountTask({
      taskId: first.id,
      workerId: "worker-a",
      leaseToken: first.leaseToken,
      nowIso: "2026-07-26T10:01:00.000Z",
      error: "first failure",
    });
    expect(retryable?.status).toBe("FAILED");
    expect(retryable?.retryCount).toBe(1);
    expect(retryable?.nextRetryAt).toBe("2026-07-26T10:04:00.000Z");

    repo.recoverAccountTasks("2026-07-26T10:04:00.000Z");
    const second = repo.claimAccountTask({
      workerId: "worker-b",
      nowIso: "2026-07-26T10:04:00.000Z",
      leaseSeconds: 300,
      concurrency: 1,
    })!;
    const terminal = repo.failAccountTask({
      taskId: second.id,
      workerId: "worker-b",
      leaseToken: second.leaseToken,
      nowIso: "2026-07-26T10:05:00.000Z",
      error: "terminal failure",
    });
    expect(terminal?.status).toBe("FAILED");
    expect(terminal?.nextRetryAt).toBeNull();
    expect(repo.getAccount("tiktok", "alice")?.nextRunAt).toBe(
      "2026-07-26T11:05:00.000Z",
    );

    const nextRound = repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "manual",
      nowIso: "2026-07-26T10:06:00.000Z",
    });
    expect(nextRound.created).toBeTrue();
    expect(nextRound.task.id).not.toBe(created.task.id);
  });

  it("有活跃任务的账号不会反复占用 due 查询窗口", () => {
    const { repo } = createRepo();
    for (const accountId of ["a", "b", "c"]) {
      repo.upsertAccount({
        platform: "tiktok",
        accountId,
        nextRunAt: "2026-07-26T10:00:00.000Z",
      });
    }
    repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "a",
      source: "due",
      nowIso: "2026-07-26T10:00:00.000Z",
    });

    const due = repo.listDueAccounts({
      platform: "tiktok",
      nowIso: "2026-07-26T10:01:00.000Z",
      limit: 2,
    });
    expect(due.map((account) => account.accountId)).toEqual(["b", "c"]);
  });
});
