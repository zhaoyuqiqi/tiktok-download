import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initSchema, openDatabase } from "./db.ts";
import { StateRepository } from "./repository.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-downloader-"));
  tempDirs.push(dir);

  const dbPath = join(dir, "state.db");
  const db = openDatabase(dbPath);
  initSchema(db);
  const repo = new StateRepository(db);

  return { dir, dbPath, db, repo };
}

describe("StateRepository", () => {
  it("账号游标可写入并读取", () => {
    const { repo } = createRepo();

    const saved = repo.upsertAccount({
      platform: "tiktok",
      accountId: "@alice",
      nextRunAt: "2026-07-03T18:00:00Z",
      lastPostAt: "2026-07-03T17:58:00Z",
      lastVideoId: "123",
      active: true,
    });

    expect(saved.accountId).toBe("@alice");
    expect(saved.nextRunAt).toBe("2026-07-03T18:00:00Z");
    expect(saved.lastVideoId).toBe("123");
    expect(saved.active).toBeTrue();

    const loaded = repo.getAccount("tiktok", "@alice");
    expect(loaded).not.toBeNull();
    expect(loaded?.lastPostAt).toBe("2026-07-03T17:58:00Z");
  });

  it("帖子去重可查询并重复写入覆盖状态", () => {
    const { repo } = createRepo();

    expect(repo.isFetched("tiktok", "v-1")).toBeFalse();

    const first = repo.markFetched({
      platform: "tiktok",
      postId: "v-1",
      status: "success",
      attempts: 1,
      fetchedAt: "2026-07-03T18:00:01Z",
      publishedAt: "2026-07-03T17:00:00Z",
    });

    expect(first.status).toBe("success");
    expect(repo.isFetched("tiktok", "v-1")).toBeTrue();

    const second = repo.markFetched({
      platform: "tiktok",
      postId: "v-1",
      status: "retrying",
      attempts: 2,
      fetchedAt: "2026-07-03T18:01:01Z",
      publishedAt: "2026-07-03T17:00:00Z",
    });

    expect(second.status).toBe("retrying");
    expect(second.attempts).toBe(2);
    expect(second.fetchedAt).toBe("2026-07-03T18:01:01Z");
  });

  it("重启后仍可保留账号游标与去重状态", () => {
    const first = createRepo();

    first.repo.upsertAccount({
      platform: "tiktok",
      accountId: "@bob",
      nextRunAt: "2026-07-03T19:00:00Z",
      lastVideoId: "video-9",
      active: true,
    });
    first.repo.markFetched({
      platform: "tiktok",
      postId: "video-9",
      status: "success",
      attempts: 1,
      fetchedAt: "2026-07-03T18:59:59Z",
    });

    first.db.close();

    const reopenedDb = openDatabase(first.dbPath);
    initSchema(reopenedDb);
    const reopenedRepo = new StateRepository(reopenedDb);

    const account = reopenedRepo.getAccount("tiktok", "@bob");
    expect(account).not.toBeNull();
    expect(account?.lastVideoId).toBe("video-9");
    expect(reopenedRepo.isFetched("tiktok", "video-9")).toBeTrue();

    reopenedDb.close();
  });

  it("listDueAccounts: 仅返回到期且 active 的账号,并按时间排序和 limit 截断", () => {
    const { repo } = createRepo();

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@a",
      nextRunAt: "2026-07-03T10:01:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@b",
      nextRunAt: "2026-07-03T10:00:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@c",
      nextRunAt: "2026-07-03T10:02:00Z",
      active: false,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@d",
      nextRunAt: "2026-07-03T10:10:00Z",
      active: true,
    });

    const due = repo.listDueAccounts({
      platform: "tiktok",
      nowIso: "2026-07-03T10:05:00Z",
      limit: 2,
    });

    expect(due.map((it) => it.accountId)).toEqual(["@b", "@a"]);
  });

  it("可查询账号列表并统计 active/due/fetched", () => {
    const { repo } = createRepo();

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@a",
      nextRunAt: "2026-07-03T10:00:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@b",
      nextRunAt: "2026-07-03T10:10:00Z",
      active: true,
    });
    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@c",
      nextRunAt: "2026-07-03T10:20:00Z",
      active: false,
    });

    repo.markFetched({
      platform: "tiktok",
      postId: "v-1",
      status: "success",
      attempts: 1,
      fetchedAt: "2026-07-03T10:00:01Z",
    });

    repo.setAccountActive("tiktok", "@b", false);

    const listed = repo.listAccounts("tiktok", 10);
    expect(listed).toHaveLength(3);
    expect(repo.countAccounts("tiktok")).toBe(3);
    expect(repo.countAccounts("tiktok", true)).toBe(1);
    expect(repo.countAccounts("tiktok", false)).toBe(2);
    expect(repo.countDueAccounts("tiktok", "2026-07-03T10:05:00Z")).toBe(1);
    expect(repo.countFetchedPosts("tiktok")).toBe(1);
  });
});
