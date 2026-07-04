import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema, openDatabase } from "../storage/db.ts";
import { StateRepository } from "../storage/repository.ts";
import { reconcileAccounts } from "./accountReconciler.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-reconcile-"));
  tempDirs.push(dir);

  const db = openDatabase(join(dir, "state.db"));
  initSchema(db);

  return {
    db,
    repo: new StateRepository(db),
  };
}

describe("reconcileAccounts", () => {
  it("新增账号写入 next_run_at=now+jitter，且不触发抓取", () => {
    const { repo } = createRepo();
    const fixedNow = new Date("2026-07-03T10:00:00.000Z");

    const result = reconcileAccounts(repo, {
      platform: "tiktok",
      accountIds: ["@alice", "@bob", "@alice"],
      jitterRangeMs: [1_000, 1_000],
      now: () => fixedNow,
      random: () => 0.5,
    });

    expect(result).toEqual({
      totalExternal: 2,
      added: 2,
      reactivated: 0,
      deactivated: 0,
    });

    const alice = repo.getAccount("tiktok", "@alice");
    const bob = repo.getAccount("tiktok", "@bob");
    expect(alice?.nextRunAt).toBe("2026-07-03T10:00:01.000Z");
    expect(bob?.nextRunAt).toBe("2026-07-03T10:00:01.000Z");
    expect(alice?.active).toBeTrue();
    expect(bob?.active).toBeTrue();
  });

  it("已存在账号不覆盖 next_run_at/last_post_at，移除账号标记 inactive", () => {
    const { repo } = createRepo();

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@keep",
      nextRunAt: "2026-07-03T11:00:00Z",
      lastPostAt: "2026-07-03T09:00:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@remove",
      nextRunAt: "2026-07-03T12:00:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@inactive",
      nextRunAt: "2026-07-03T13:00:00Z",
      active: false,
    });

    const result = reconcileAccounts(repo, {
      platform: "tiktok",
      accountIds: ["@keep", "@inactive"],
      now: () => new Date("2026-07-03T10:00:00Z"),
      jitterRangeMs: [0, 0],
      random: () => 0,
    });

    expect(result).toEqual({
      totalExternal: 2,
      added: 0,
      reactivated: 1,
      deactivated: 1,
    });

    const keep = repo.getAccount("tiktok", "@keep");
    const removed = repo.getAccount("tiktok", "@remove");
    const inactive = repo.getAccount("tiktok", "@inactive");

    expect(keep?.nextRunAt).toBe("2026-07-03T11:00:00Z");
    expect(keep?.lastPostAt).toBe("2026-07-03T09:00:00Z");
    expect(removed?.active).toBeFalse();
    expect(inactive?.active).toBeTrue();
  });
});
