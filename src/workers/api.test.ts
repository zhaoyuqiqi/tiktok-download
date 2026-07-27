import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server.ts";
import { initSchema, openDatabase } from "../storage/db.ts";
import { StateRepository } from "../storage/repository.ts";
import type { ClaimedAccountTask } from "./protocol.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-worker-api-"));
  tempDirs.push(dir);
  const db = openDatabase(join(dir, "state.db"));
  initSchema(db);
  const repo = new StateRepository(db);
  let current = new Date("2026-07-26T10:00:00.000Z");
  const app = createApp({
    workerApi: {
      repo,
      token: "worker-secret",
      concurrency: 2,
      leaseSeconds: 300,
      now: () => current,
    },
  });
  return {
    app,
    repo,
    setNow(value: string) {
      current = new Date(value);
    },
  };
}

function request(
  path: string,
  body: Record<string, unknown>,
  token = "worker-secret",
) {
  return new Request(`http://localhost/internal/workers${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("worker API", () => {
  it("拒绝未鉴权请求", async () => {
    const { app } = setup();
    const response = await app.handle(
      request(
        "/register",
        {
          workerId: "action-1",
          workerType: "github-action",
        },
        "wrong",
      ),
    );
    expect(response.status).toBe(401);
  });

  it("支持注册、领取、续租、逐帖提交和账号完成闭环", async () => {
    const { app, repo, setNow } = setup();
    repo.enqueueAccountTask({
      platform: "tiktok",
      accountId: "alice",
      source: "manual",
      options: { limit: 3 },
      nowIso: "2026-07-26T10:00:00.000Z",
    });

    const registered = await app.handle(
      request("/register", {
        workerId: "action-1",
        workerType: "github-action",
      }),
    );
    expect(registered.status).toBe(200);

    const claimedResponse = await app.handle(
      request("/claim", { workerId: "action-1" }),
    );
    expect(claimedResponse.status).toBe(200);
    const claimedBody = (await claimedResponse.json()) as {
      task: ClaimedAccountTask;
    };
    expect(claimedBody.task.accountId).toBe("alice");
    expect(claimedBody.task.options).toEqual({ limit: 3 });

    setNow("2026-07-26T10:02:00.000Z");
    const lease = {
      taskId: claimedBody.task.id,
      workerId: "action-1",
      leaseToken: claimedBody.task.leaseToken,
    };
    const heartbeat = await app.handle(request("/heartbeat", lease));
    expect(heartbeat.status).toBe(200);
    expect((await heartbeat.json()).leaseExpiresAt).toBe(
      "2026-07-26T10:05:00.000Z",
    );

    const before = await app.handle(
      request("/post-exists", {
        platform: "tiktok",
        postId: "post-1",
      }),
    );
    expect((await before.json()).exists).toBeFalse();

    const postResult = await app.handle(
      request("/post-result", {
        ...lease,
        platform: "tiktok",
        accountId: "alice",
        postId: "post-1",
        publishedAt: "2026-07-26T09:00:00.000Z",
        status: "success",
        payload: { title: "first post" },
      }),
    );
    expect(postResult.status).toBe(200);
    expect(repo.isFetched("tiktok", "post-1")).toBeTrue();

    const accountResult = await app.handle(
      request("/account-result", {
        ...lease,
        status: "partial",
        summary: { newCount: 1, failedCount: 1 },
      }),
    );
    expect(accountResult.status).toBe(200);
    const completed = repo.getAccountTask(claimedBody.task.id);
    expect(completed?.status).toBe("SUCCESS");
    expect(completed?.resultSummary).toEqual({
      newCount: 1,
      failedCount: 1,
      outcome: "partial",
    });
    expect(repo.getAccount("tiktok", "alice")?.nextRunAt).toBe(
      "2026-07-26T10:32:00.000Z",
    );

    const repeatedAccountResult = await app.handle(
      request("/account-result", {
        ...lease,
        status: "partial",
        summary: { newCount: 1, failedCount: 1 },
      }),
    );
    expect(repeatedAccountResult.status).toBe(200);
    expect(repo.getAccountTask(claimedBody.task.id)?.status).toBe("SUCCESS");

    const staleHeartbeat = await app.handle(request("/heartbeat", lease));
    expect(staleHeartbeat.status).toBe(409);
  });

  it("未注册 worker 不能领取任务", async () => {
    const { app } = setup();
    const response = await app.handle(
      request("/claim", { workerId: "unknown" }),
    );
    expect(response.status).toBe(409);
  });
});
