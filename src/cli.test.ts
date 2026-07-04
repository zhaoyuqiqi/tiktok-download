import { describe, expect, it } from "bun:test";
import { createApp } from "./server.ts";

describe("HTTP 服务入口", () => {
  it("GET /health 返回服务状态", async () => {
    const app = createApp();
    const response = await app.handle(new Request("http://localhost/health"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.status).toBe("ok");
    expect(payload.service).toBe("tiktok-downloader");
    expect(typeof payload.timestamp).toBe("string");
  });

  it("POST /fetch 受理主动触发并入队", async () => {
    const triggerCalls: Array<{ accountId: string; limit?: number }> = [];
    const upserts: string[] = [];

    const app = createApp({
      repo: {
        getAccount: () => null,
        upsertAccount: ({ accountId }) => {
          upserts.push(accountId);
          return {
            platform: "tiktok",
            accountId,
            nextRunAt: "2026-07-03T10:00:00Z",
            lastPostAt: null,
            lastVideoId: null,
            active: true,
          };
        },
        listAccounts: () => [],
        countAccounts: () => 0,
        countDueAccounts: () => 0,
        countFetchedPosts: () => 0,
      },
      scheduler: {
        runningCount: 0,
        async trigger(accountId, options) {
          triggerCalls.push({ accountId, limit: options?.limit });
        },
      },
    });

    const response = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ accountId: "@alice", limit: 3 }),
      }),
    );

    const payload = await response.json();
    expect(response.status).toBe(202);
    expect(payload.accepted).toBeTrue();
    expect(payload.limit).toBe(3);
    expect(triggerCalls).toEqual([{ accountId: "@alice", limit: 3 }]);
    expect(upserts).toEqual(["@alice"]);
  });

  it("POST /fetch 缺少 accountId 返回 400", async () => {
    const app = createApp();
    const response = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("GET /status 返回调度与账号状态", async () => {
    const app = createApp({
      repo: {
        getAccount: () => null,
        upsertAccount: () => {
          throw new Error("should not upsert in /status");
        },
        listAccounts: () => [
          {
            platform: "tiktok",
            accountId: "@alice",
            nextRunAt: "2026-07-03T10:00:00Z",
            lastPostAt: null,
            lastVideoId: null,
            active: true,
          },
        ],
        countAccounts: (_platform, active) => (active === undefined ? 1 : active ? 1 : 0),
        countDueAccounts: () => 1,
        countFetchedPosts: () => 3,
      },
      scheduler: {
        runningCount: 1,
        async trigger() {},
      },
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    const response = await app.handle(new Request("http://localhost/status"));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.scheduler.runningCount).toBe(1);
    expect(payload.accounts.total).toBe(1);
    expect(payload.accounts.active).toBe(1);
    expect(payload.accounts.inactive).toBe(0);
    expect(payload.accounts.due).toBe(1);
    expect(payload.fetched.total).toBe(3);
    expect(payload.accounts.items[0]?.accountId).toBe("@alice");
  });

  it("未知路由返回 404", async () => {
    const app = createApp();
    const response = await app.handle(new Request("http://localhost/not-found"));

    expect(response.status).toBe(404);
  });
});
