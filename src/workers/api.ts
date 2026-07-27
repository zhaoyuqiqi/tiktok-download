import { Elysia } from "elysia";
import type {
  ClaimAccountTaskInput,
  CompleteAccountTaskInput,
  FailAccountTaskInput,
  MarkFetchedPostInput,
  RecordTaskPostResultInput,
  TaskLeaseInput,
} from "../storage/repository.ts";
import type { AccountRow } from "../storage/db.ts";
import { computeNextRunAt } from "../pipeline/accountIngest.ts";
import type {
  AccountTask,
  ClaimedAccountTask,
  TaskPostResult,
  WorkerRegistration,
  WorkerType,
} from "./protocol.ts";

export interface WorkerApiRepository {
  registerWorker(
    workerId: string,
    workerType: WorkerType,
    nowIso: string,
  ): WorkerRegistration;
  getWorker(workerId: string): WorkerRegistration | null;
  touchWorker(workerId: string, nowIso: string): boolean;
  finishWorker(workerId: string, nowIso: string): boolean;
  claimAccountTask(input: ClaimAccountTaskInput): ClaimedAccountTask | null;
  heartbeatAccountTask(
    input: TaskLeaseInput,
    leaseSeconds: number,
  ): AccountTask | null;
  completeAccountTask(input: CompleteAccountTaskInput): AccountTask | null;
  failAccountTask(input: FailAccountTaskInput): AccountTask | null;
  recordTaskPostResult(input: RecordTaskPostResultInput): TaskPostResult | null;
  isFetched(platform: string, postId: string): boolean;
  markFetched(input: MarkFetchedPostInput): unknown;
  getAccount(platform: string, accountId: string): AccountRow | null;
  getAccountTask(taskId: string): AccountTask | null;
}

export interface WorkerApiOptions {
  repo: WorkerApiRepository;
  token: string;
  concurrency: number;
  leaseSeconds?: number;
  heartbeatLeaseSeconds?: number;
  now?: () => Date;
}

function objectBody(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : "";
}

function leaseInput(
  body: Record<string, unknown>,
  nowIso: string,
): TaskLeaseInput | null {
  const taskId = stringField(body, "taskId");
  const workerId = stringField(body, "workerId");
  const leaseToken = stringField(body, "leaseToken");
  if (taskId.length === 0 || workerId.length === 0 || leaseToken.length === 0) {
    return null;
  }
  return { taskId, workerId, leaseToken, nowIso };
}

export function createWorkerApi(options: WorkerApiOptions) {
  if (options.token.trim().length === 0) {
    throw new Error("worker API token 不能为空");
  }
  if (options.concurrency <= 0) {
    throw new Error("worker API concurrency 必须为正数");
  }

  const leaseSeconds = options.leaseSeconds ?? 300;
  const heartbeatLeaseSeconds = options.heartbeatLeaseSeconds ?? 180;
  if (leaseSeconds <= 0 || heartbeatLeaseSeconds <= 0) {
    throw new Error("worker API 租约时长必须为正数");
  }
  const nowIso = () => (options.now?.() ?? new Date()).toISOString();

  return new Elysia({ prefix: "/internal/workers" })
    .onBeforeHandle(({ request, set }) => {
      if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
        set.status = 401;
        return { error: "worker API 鉴权失败" };
      }
    })
    .post("/register", ({ body, set }) => {
      const payload = objectBody(body);
      const workerId = stringField(payload, "workerId");
      const workerType = stringField(payload, "workerType") as WorkerType;
      if (
        workerId.length === 0 ||
        !["local", "github-action"].includes(workerType)
      ) {
        set.status = 400;
        return { error: "workerId 或 workerType 无效" };
      }
      return {
        worker: options.repo.registerWorker(workerId, workerType, nowIso()),
      };
    })
    .post("/claim", ({ body, set }) => {
      const payload = objectBody(body);
      const workerId = stringField(payload, "workerId");
      const worker = options.repo.getWorker(workerId);
      if (worker === null || worker.status !== "ACTIVE") {
        set.status = 409;
        return { error: "worker 尚未注册或已离线" };
      }
      const task = options.repo.claimAccountTask({
        workerId,
        nowIso: nowIso(),
        leaseSeconds,
        concurrency: options.concurrency,
      });
      options.repo.touchWorker(workerId, nowIso());
      return { task };
    })
    .post("/heartbeat", ({ body, set }) => {
      const input = leaseInput(objectBody(body), nowIso());
      if (input === null) {
        set.status = 400;
        return { error: "taskId、workerId、leaseToken 均为必填" };
      }
      const task = options.repo.heartbeatAccountTask(
        input,
        heartbeatLeaseSeconds,
      );
      if (task === null) {
        set.status = 409;
        return { error: "任务租约不存在或已过期" };
      }
      options.repo.touchWorker(input.workerId, input.nowIso);
      return { taskId: task.id, leaseExpiresAt: task.leaseExpiresAt };
    })
    .post("/post-exists", ({ body, set }) => {
      const payload = objectBody(body);
      const platform = stringField(payload, "platform") || "tiktok";
      const postId = stringField(payload, "postId");
      if (postId.length === 0) {
        set.status = 400;
        return { error: "postId 为必填" };
      }
      return { exists: options.repo.isFetched(platform, postId) };
    })
    .post("/post-result", ({ body, set }) => {
      const payload = objectBody(body);
      const now = nowIso();
      const lease = leaseInput(payload, now);
      const platform = stringField(payload, "platform") || "tiktok";
      const accountId = stringField(payload, "accountId");
      const postId = stringField(payload, "postId");
      const status = stringField(payload, "status");
      const resultPayload = objectBody(payload.payload);
      if (
        lease === null ||
        accountId.length === 0 ||
        postId.length === 0 ||
        !["success", "failed"].includes(status)
      ) {
        set.status = 400;
        return { error: "帖子结果参数无效" };
      }

      const result = options.repo.recordTaskPostResult({
        ...lease,
        platform,
        accountId,
        postId,
        status: status as "success" | "failed",
        payload: resultPayload,
      });
      if (result === null) {
        set.status = 409;
        return { error: "任务租约不存在或已过期" };
      }

      if (status === "success") {
        const publishedAt = stringField(payload, "publishedAt") || null;
        options.repo.markFetched({
          platform,
          accountId,
          postId,
          publishedAt,
          status: "success",
          attempts: 1,
          fetchedAt: now,
        });
      }
      return { result };
    })
    .post("/account-result", ({ body, set }) => {
      const payload = objectBody(body);
      const lease = leaseInput(payload, nowIso());
      const status = stringField(payload, "status");
      if (
        lease === null ||
        !["success", "partial", "failed"].includes(status)
      ) {
        set.status = 400;
        return { error: "账号结果参数无效" };
      }

      if (status === "failed") {
        const task = options.repo.failAccountTask({
          ...lease,
          error: stringField(payload, "error") || "远端 worker 执行失败",
        });
        if (task === null) {
          set.status = 409;
          return { error: "任务租约不存在或已过期" };
        }
        return { task };
      }

      const claimedTask = options.repo.getAccountTask(lease.taskId);
      if (claimedTask === null) {
        set.status = 409;
        return { error: "任务租约不存在或已过期" };
      }
      const summary = objectBody(payload.summary);
      const existing = options.repo.getAccount(
        claimedTask.platform,
        claimedTask.accountId,
      );
      const summaryLastPostAt = stringField(summary, "lastPostAt") || null;
      const summaryLastVideoId = stringField(summary, "lastVideoId") || null;
      const explicitNextRunAt = stringField(summary, "nextRunAt");
      const newCountRaw = summary.newCount;
      const newCount =
        typeof newCountRaw === "number" && Number.isSafeInteger(newCountRaw)
          ? Math.max(0, newCountRaw)
          : 0;
      const nextRunAt = Number.isFinite(Date.parse(explicitNextRunAt))
        ? new Date(explicitNextRunAt).toISOString()
        : computeNextRunAt({
            now: new Date(lease.nowIso),
            lastPostAt: summaryLastPostAt || existing?.lastPostAt,
            newPostsCount: newCount,
          });
      const task = options.repo.completeAccountTask({
        ...lease,
        summary: {
          ...summary,
          outcome: status,
        },
        accountUpdate: {
          platform: claimedTask.platform,
          accountId: claimedTask.accountId,
          nextRunAt,
          lastPostAt: summaryLastPostAt || existing?.lastPostAt || null,
          lastVideoId: summaryLastVideoId || existing?.lastVideoId || null,
          active: existing?.active ?? true,
        },
      });
      if (task === null) {
        set.status = 409;
        return { error: "任务租约不存在或已过期" };
      }
      return { task };
    })
    .post("/unregister", ({ body, set }) => {
      const workerId = stringField(objectBody(body), "workerId");
      if (workerId.length === 0) {
        set.status = 400;
        return { error: "workerId 为必填" };
      }
      return { offline: options.repo.finishWorker(workerId, nowIso()) };
    });
}
