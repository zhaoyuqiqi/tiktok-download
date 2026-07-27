import { describe, expect, it, spyOn } from "bun:test";
import type {
  InstarPostSyncClient,
  InstarServerClient,
  InstarStarSyncClient,
} from "../integration/instarServer.ts";
import type { ClaimedAccountTask } from "../workers/protocol.ts";
import { GithubActionWorker } from "./github-actions.ts";
import type { InstarPost } from "./types/instar";
import type { WorkerLogLevel } from "./worker.ts";

interface RecordedRequest {
  path: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

interface RecordedLog {
  level: WorkerLogLevel;
  event: string;
  fields: Record<string, unknown>;
}

function claimedTask(): ClaimedAccountTask {
  return {
    id: "task-1",
    platform: "tiktok",
    accountId: "alice",
    source: "manual",
    options: { limit: 3, categoryId: 7, zhName: "爱丽丝" },
    status: "RUNNING",
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    workerId: "action-1",
    leaseToken: "lease-1",
    leaseExpiresAt: "2026-07-27T10:05:00.000Z",
    resultSummary: null,
    lastError: null,
    createdAt: "2026-07-27T10:00:00.000Z",
    updatedAt: "2026-07-27T10:00:00.000Z",
    startedAt: "2026-07-27T10:00:00.000Z",
    completedAt: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

class TestGithubActionWorker extends GithubActionWorker {
  startTask(task: ClaimedAccountTask): Promise<void> {
    return this.onTaskStart(task);
  }

  endTask(task: ClaimedAccountTask): Promise<void> {
    return this.onTaskEnd(task);
  }
}

describe("GithubActionWorker", () => {
  it("领取任务后连续超时无帖子成功时停止 worker 和 heartbeat", async () => {
    const exitCodes: number[] = [];
    const logs: RecordedLog[] = [];
    let heartbeatCount = 0;
    const task = claimedTask();
    const worker = new TestGithubActionWorker({
      apiBaseUrl: "https://service.example.com",
      apiToken: "worker-secret",
      workerId: "action-1",
      heartbeatIntervalMs: 1,
      noSuccessTimeoutMs: 30,
      terminateWorker(exitCode) {
        exitCodes.push(exitCode);
      },
      logger(level, event, fields = {}) {
        logs.push({ level, event, fields });
      },
      starSyncClient: { async syncStarProfile() {} },
      postSyncClient: { async notifyPostSynced() {} },
      async fetchImpl(input) {
        if (new URL(String(input)).pathname.endsWith("/heartbeat")) {
          heartbeatCount += 1;
        }
        return jsonResponse({ ok: true });
      },
    });

    await worker.startTask(task);
    await Bun.sleep(60);
    const countAfterTimeout = heartbeatCount;
    await Bun.sleep(10);
    await worker.endTask(task);

    expect(exitCodes).toEqual([1]);
    expect(heartbeatCount).toBe(countAfterTimeout);
    expect(logs).toContainEqual({
      level: "error",
      event: "account.task.no_success_timeout",
      fields: expect.objectContaining({
        taskId: "task-1",
        accountId: "alice",
        timeoutMs: 30,
      }),
    });
  });

  it("帖子同步并成功上报后重置无成功超时", async () => {
    const exitCodes: number[] = [];
    const task = claimedTask();
    const worker = new TestGithubActionWorker({
      apiBaseUrl: "https://service.example.com",
      apiToken: "worker-secret",
      workerId: "action-1",
      noSuccessTimeoutMs: 100,
      terminateWorker(exitCode) {
        exitCodes.push(exitCode);
      },
      starSyncClient: { async syncStarProfile() {} },
      postSyncClient: { async notifyPostSynced() {} },
      logger() {},
      async fetchImpl() {
        return jsonResponse({ ok: true });
      },
    });

    await worker.startTask(task);
    await Bun.sleep(60);
    await worker.syncPostDetail({
      insPostId: "post-1",
      starName: "alice",
      fullName: "Alice",
      title: "first",
      isTop: false,
      insStarId: "star-1",
      publishTime: 1_785_144_400,
      resources: [],
    });
    await Bun.sleep(60);
    expect(exitCodes).toEqual([]);
    await worker.endTask(task);
  });

  it("默认将结构化阶段日志写入 GitHub Actions 控制台", async () => {
    const messages: string[] = [];
    const info = spyOn(console, "info").mockImplementation((message) => {
      messages.push(String(message));
    });

    try {
      const worker = new GithubActionWorker({
        apiBaseUrl: "https://service.example.com",
        apiToken: "worker-secret",
        workerId: "action-log-test",
        starSyncClient: { async syncStarProfile() {} },
        postSyncClient: { async notifyPostSynced() {} },
        maxEmptyClaims: 1,
        async fetchImpl(input) {
          const path = new URL(String(input)).pathname;
          return jsonResponse(path.endsWith("/claim") ? { task: null } : { ok: true });
        },
      });

      await worker.autoSetup();
    } finally {
      info.mockRestore();
    }

    const records = messages.map((message) => JSON.parse(message) as Record<string, unknown>);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "info",
          scope: "github-actions-worker",
          event: "worker.register.start",
          workerId: "action-log-test",
        }),
        expect.objectContaining({
          event: "task.claim.empty",
          workerId: "action-log-test",
        }),
        expect.objectContaining({
          event: "worker.unregister.done",
          workerId: "action-log-test",
        }),
      ]),
    );
  });

  it("完成注册、claim、心跳、同步、结果提交和注销闭环", async () => {
    const requests: RecordedRequest[] = [];
    const profiles: unknown[] = [];
    const posts: unknown[] = [];
    const accountCallbacks: unknown[] = [];
    const logs: RecordedLog[] = [];
    let claimCount = 0;
    let heartbeatCount = 0;
    let worker!: GithubActionWorker;

    const fetchImpl = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      requests.push({
        path: url.pathname,
        body,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.pathname.endsWith("/claim")) {
        claimCount += 1;
        return jsonResponse({ task: claimCount === 1 ? claimedTask() : null });
      }
      if (url.pathname.endsWith("/post-exists")) {
        return jsonResponse({ exists: false });
      }
      if (url.pathname.endsWith("/heartbeat")) {
        heartbeatCount += 1;
      }
      return jsonResponse({ ok: true });
    };

    const starSyncClient: InstarStarSyncClient = {
      async syncStarProfile(payload) {
        profiles.push(payload);
      },
    };
    const postSyncClient: InstarPostSyncClient = {
      async notifyPostSynced(payload) {
        posts.push(payload);
      },
    };
    const accountClient: InstarServerClient = {
      async notifyAccountCompleted(payload) {
        accountCallbacks.push(payload);
      },
    };
    const post: InstarPost = {
      insPostId: "post-1",
      starName: "alice",
      fullName: "Alice",
      title: "first",
      isTop: false,
      insStarId: "star-1",
      publishTime: 1_785_144_400,
      resources: [],
    };

    worker = new GithubActionWorker({
      apiBaseUrl: "https://service.example.com/",
      apiToken: "worker-secret",
      workerId: "action-1",
      fetchImpl,
      starSyncClient,
      postSyncClient,
      accountClient,
      heartbeatIntervalMs: 1,
      maxEmptyClaims: 1,
      logger(level, event, fields = {}) {
        logs.push({ level, event, fields });
      },
      executeTask: async (task) => {
        expect(task.options).toEqual({
          limit: 3,
          categoryId: 7,
          zhName: "爱丽丝",
        });
        expect(await worker.isExists("post-1")).toBeFalse();
        await worker.syncStarProfile({
          insStarId: "star-1",
          starName: "alice",
          fullName: "Alice",
          avatar: "avatar.jpg",
          postCount: 1,
          followerCount: 2,
          followingCount: 3,
          isDel: 0,
        });
        await worker.syncPostDetail(post, "2026-07-27T09:00:00.000Z");
        await Bun.sleep(5);
        return {
          outcome: "success",
          newCount: 1,
          failedCount: 0,
          lastPostAt: "2026-07-27T09:00:00.000Z",
          lastVideoId: "post-1",
        };
      },
    });

    await worker.autoSetup();

    expect(profiles).toHaveLength(1);
    expect(posts).toEqual([post]);
    expect(accountCallbacks).toEqual([
      { starId: "alice", token: "instar", status: 1 },
    ]);
    expect(heartbeatCount).toBeGreaterThan(0);
    expect(requests.map((request) => request.path)).toContain(
      "/internal/workers/post-result",
    );
    expect(requests.map((request) => request.path)).toContain(
      "/internal/workers/account-result",
    );
    expect(requests.at(0)?.path).toBe("/internal/workers/register");
    expect(requests.at(-1)?.path).toBe("/internal/workers/unregister");
    expect(
      requests.every(
        (request) => request.authorization === "Bearer worker-secret",
      ),
    ).toBeTrue();
    expect(logs.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        "worker.register.start",
        "worker.register.done",
        "task.claim.done",
        "account.task.start",
        "instar.profile.sync.start",
        "instar.profile.sync.done",
        "instar.post.sync.start",
        "instar.post.sync.done",
        "account.result.submit.done",
        "account.task.end",
        "worker.unregister.done",
      ]),
    );
    const postSyncLog = logs.find(
      (entry) => entry.event === "instar.post.sync.done",
    );
    expect(postSyncLog?.fields).toMatchObject({
      taskId: "task-1",
      accountId: "alice",
      postId: "post-1",
    });
  });

  it("账号执行异常时提交 failed 后继续空领并退出", async () => {
    const accountResults: Array<Record<string, unknown>> = [];
    const logs: RecordedLog[] = [];
    let claimCount = 0;
    const worker = new GithubActionWorker({
      apiBaseUrl: "https://service.example.com",
      apiToken: "worker-secret",
      workerId: "action-1",
      starSyncClient: { async syncStarProfile() {} },
      postSyncClient: { async notifyPostSynced() {} },
      maxEmptyClaims: 1,
      logger(level, event, fields = {}) {
        logs.push({ level, event, fields });
      },
      executeTask: async () => {
        throw new Error("profile failed");
      },
      async fetchImpl(input, init) {
        const path = new URL(String(input)).pathname;
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<
          string,
          unknown
        >;
        if (path.endsWith("/claim")) {
          claimCount += 1;
          return jsonResponse({ task: claimCount === 1 ? claimedTask() : null });
        }
        if (path.endsWith("/account-result")) {
          accountResults.push(body);
        }
        return jsonResponse({ ok: true });
      },
    });

    await worker.autoSetup();

    expect(accountResults).toHaveLength(1);
    expect(accountResults[0]?.status).toBe("failed");
    expect(accountResults[0]?.error).toBe("profile failed");
    expect(logs).toContainEqual({
      level: "error",
      event: "account.task.failed",
      fields: expect.objectContaining({
        taskId: "task-1",
        accountId: "alice",
        error: "profile failed",
      }),
    });
  });
});
