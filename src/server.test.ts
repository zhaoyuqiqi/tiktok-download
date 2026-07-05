import { describe, expect, it } from "bun:test";
import { createApp } from "./server.ts";

describe("server /fetch", () => {
  it("仅传 starId 时返回 202 并回写 accountId/starId", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice" }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accountId: string; starId: string; accepted: boolean };
    expect(body.accepted).toBeTrue();
    expect(body.accountId).toBe("@alice");
    expect(body.starId).toBe("@alice");
  });

  it("同时传 accountId 与 starId 时优先 accountId", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "@acc", starId: "@star" }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { accountId: string; starId: string; limit: number };
    expect(body.accountId).toBe("@acc");
    expect(body.starId).toBe("@acc");
    expect(body.limit).toBe(100);
  });

  it("accountId 与 starId 都缺失时返回 400", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("accountId/starId");
  });

  it("传入 limit 时会回显该值", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", limit: 3 }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { limit: number };
    expect(body.limit).toBe(3);
  });

  it("limit 非法时返回 400", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", limit: 0 }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("limit");
  });

  it("传入 categoryId 时会透传给 scheduler 并回显", async () => {
    let gotCategoryId: number | undefined;
    let gotLimit: number | undefined;

    const app = createApp({
      repo: {
        getAccount() {
          return null;
        },
        upsertAccount(input) {
          return {
            platform: input.platform,
            accountId: input.accountId,
            nextRunAt: input.nextRunAt,
            lastPostAt: input.lastPostAt ?? null,
            lastVideoId: input.lastVideoId ?? null,
            active: input.active ?? true,
          };
        },
        listAccounts() {
          return [];
        },
        countAccounts() {
          return 0;
        },
        countDueAccounts() {
          return 0;
        },
        countFetchedPosts() {
          return 0;
        },
      },
      scheduler: {
        runningCount: 0,
        async trigger(_accountId, options) {
          gotCategoryId = options?.categoryId;
          gotLimit = options?.limit;
        },
      },
    });

    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", limit: 3, categoryId: 7 }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { categoryId?: number; limit: number };
    expect(body.limit).toBe(3);
    expect(body.categoryId).toBe(7);
    expect(gotLimit).toBe(3);
    expect(gotCategoryId).toBe(7);
  });

  it("categoryId 非法时返回 400", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", categoryId: "abc" }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("categoryId");
  });

  it("categoryId 小于 -1 时返回 400", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", categoryId: -2 }),
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("categoryId");
  });

  it("categoryId 为 -1 时允许透传", async () => {
    let gotCategoryId: number | undefined;

    const app = createApp({
      repo: {
        getAccount() {
          return null;
        },
        upsertAccount(input) {
          return {
            platform: input.platform,
            accountId: input.accountId,
            nextRunAt: input.nextRunAt,
            lastPostAt: input.lastPostAt ?? null,
            lastVideoId: input.lastVideoId ?? null,
            active: input.active ?? true,
          };
        },
        listAccounts() {
          return [];
        },
        countAccounts() {
          return 0;
        },
        countDueAccounts() {
          return 0;
        },
        countFetchedPosts() {
          return 0;
        },
      },
      scheduler: {
        runningCount: 0,
        async trigger(_accountId, options) {
          gotCategoryId = options?.categoryId;
        },
      },
    });

    const res = await app.handle(
      new Request("http://localhost/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ starId: "@alice", categoryId: -1 }),
      }),
    );

    expect(res.status).toBe(202);
    const body = (await res.json()) as { categoryId?: number };
    expect(body.categoryId).toBe(-1);
    expect(gotCategoryId).toBe(-1);
  });
});
