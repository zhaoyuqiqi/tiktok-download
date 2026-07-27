import {
  HttpInstarPostSyncClient,
  HttpInstarServerClient,
  HttpInstarStarSyncClient,
  toInstarAccountCompletedPayload,
  type InstarPostSyncClient,
  type InstarServerClient,
  type InstarStarSyncClient,
} from "../integration/instarServer.ts";
import type { ClaimedAccountTask } from "../workers/protocol.ts";
import {
  BaseWorker,
  type AccountExecutionSummary,
  type BaseWorkerOptions,
  type WorkerLogger,
} from "./worker";
import type { InstarPost } from "./types/instar";
import type { InstarStarSyncPayload } from "./types/yt-dlp";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface WorkerApiErrorPayload {
  error?: string;
}

interface ClaimResponse {
  task: ClaimedAccountTask | null;
}

const DEFAULT_NO_SUCCESS_TIMEOUT_MS = 30 * 60 * 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createGithubActionsLogger(workerId: string): WorkerLogger {
  return (level, event, fields = {}) => {
    const message = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      scope: "github-actions-worker",
      event,
      workerId,
      ...fields,
    });
    if (level === "error") {
      console.error(message);
    } else if (level === "warn") {
      console.warn(message);
    } else {
      console.info(message);
    }
  };
}

export class WorkerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WorkerApiError";
  }
}

export interface GithubActionWorkerOptions extends BaseWorkerOptions {
  apiBaseUrl: string;
  apiToken: string;
  workerId: string;
  heartbeatIntervalMs?: number;
  noSuccessTimeoutMs?: number;
  terminateWorker?: (exitCode: number) => void;
  fetchImpl?: FetchLike;
  starSyncClient: InstarStarSyncClient;
  postSyncClient: InstarPostSyncClient;
  accountClient?: InstarServerClient;
}

function requiredEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  throw new Error(`${names.join(" 或 ")} 未配置`);
}

function optionalEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数`);
  }
  return value;
}

function resolveStarSyncUrl(explicitUrl: string, postSyncUrl: string): string {
  if (explicitUrl) {
    return explicitUrl;
  }
  try {
    const url = new URL(postSyncUrl);
    url.pathname = "/star/api/sync";
    url.search = "";
    return url.toString();
  } catch {
    throw new Error("APP_INSTAR_STAR_SYNC_URL 未配置且无法从帖子同步地址推导");
  }
}

function createWorkerId(env: NodeJS.ProcessEnv): string {
  const explicit = optionalEnv(env, "APP_WORKER_ID", "WORKER_ID");
  if (explicit) {
    return explicit;
  }
  const runId = optionalEnv(env, "GITHUB_RUN_ID") || "manual";
  const attempt = optionalEnv(env, "GITHUB_RUN_ATTEMPT") || "1";
  const job = optionalEnv(env, "GITHUB_JOB") || "crawler";
  return `github-action-${runId}-${attempt}-${job}`;
}

export class GithubActionWorker extends BaseWorker {
  private readonly apiBaseUrl: string;
  private readonly apiToken: string;
  private readonly workerId: string;
  private readonly heartbeatIntervalMs: number;
  private readonly noSuccessTimeoutMs: number;
  private readonly terminateWorker: (exitCode: number) => void;
  private readonly fetchImpl: FetchLike;
  private readonly starSyncClient: InstarStarSyncClient;
  private readonly postSyncClient: InstarPostSyncClient;
  private readonly accountClient?: InstarServerClient;
  private currentTask: ClaimedAccountTask | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private noSuccessTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatInFlight = false;
  private leaseLost = false;

  constructor(options: GithubActionWorkerOptions) {
    const workerId = options.workerId.trim();
    super({
      ...options,
      logger: options.logger ?? createGithubActionsLogger(workerId),
    });
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/g, "");
    this.apiToken = options.apiToken.trim();
    this.workerId = workerId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.noSuccessTimeoutMs =
      options.noSuccessTimeoutMs ?? DEFAULT_NO_SUCCESS_TIMEOUT_MS;
    this.terminateWorker =
      options.terminateWorker ?? ((exitCode) => process.exit(exitCode));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.starSyncClient = options.starSyncClient;
    this.postSyncClient = options.postSyncClient;
    this.accountClient = options.accountClient;

    if (!this.apiBaseUrl || !this.apiToken || !this.workerId) {
      throw new Error("GitHub Actions worker API 配置不完整");
    }
    if (this.heartbeatIntervalMs <= 0) {
      throw new Error("heartbeatIntervalMs 必须为正数");
    }
    if (this.noSuccessTimeoutMs <= 0) {
      throw new Error("noSuccessTimeoutMs 必须为正数");
    }
  }

  protected override async onWorkerStart(): Promise<void> {
    this.log("info", "worker.register.start");
    await this.workerRequest("/register", {
      workerId: this.workerId,
      workerType: "github-action",
    });
    this.log("info", "worker.register.done");
  }

  protected override async onWorkerEnd(): Promise<void> {
    this.stopHeartbeat();
    this.stopNoSuccessWatchdog();
    this.log("info", "worker.unregister.start");
    try {
      await this.workerRequest("/unregister", { workerId: this.workerId });
      this.log("info", "worker.unregister.done");
    } catch (error) {
      this.log("warn", "worker.unregister.failed", {
        error: errorMessage(error),
      });
    }
  }

  protected override async claimTasks(): Promise<ClaimedAccountTask | null> {
    this.log("info", "task.claim.start");
    const response = await this.workerRequest<ClaimResponse>("/claim", {
      workerId: this.workerId,
    });
    this.log(
      "info",
      response.task === null ? "task.claim.empty" : "task.claim.done",
      {
        ...(response.task === null
          ? {}
          : {
              taskId: response.task.id,
              accountId: response.task.accountId,
              source: response.task.source,
            }),
      },
    );
    return response.task;
  }

  protected override async onTaskStart(
    task: ClaimedAccountTask,
  ): Promise<void> {
    this.currentTask = task;
    this.leaseLost = false;
    this.startHeartbeat();
    this.startNoSuccessWatchdog(task);
    this.log("info", "account.task.start", {
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
    });
  }

  protected override async onTaskSuccess(
    task: ClaimedAccountTask,
    summary: AccountExecutionSummary,
  ): Promise<void> {
    this.assertActiveTask(task);
    this.log("info", "account.result.submit.start", {
      outcome: summary.outcome,
      newCount: summary.newCount,
      failedCount: summary.failedCount,
    });
    await this.workerRequest("/account-result", {
      ...this.leasePayload(task),
      status: summary.outcome,
      summary,
    });
    this.log("info", "account.result.submit.done", {
      outcome: summary.outcome,
    });
    await this.notifyAccountCompleted(task.accountId, 1);
  }

  protected override async onTaskFailure(
    task: ClaimedAccountTask,
    error: unknown,
  ): Promise<void> {
    this.assertActiveTask(task);
    const message = errorMessage(error);
    this.log("error", "account.task.failed", { error: message });
    this.log("info", "account.result.submit.start", { outcome: "failed" });
    await this.workerRequest("/account-result", {
      ...this.leasePayload(task),
      status: "failed",
      error: message,
    });
    this.log("info", "account.result.submit.done", { outcome: "failed" });
    await this.notifyAccountCompleted(task.accountId, 0);
  }

  protected override async onTaskEnd(task: ClaimedAccountTask): Promise<void> {
    this.stopHeartbeat();
    this.stopNoSuccessWatchdog();
    this.log("info", "account.task.end", { taskId: task.id });
    this.currentTask = null;
    this.leaseLost = false;
  }

  public override async isExists(postId: string): Promise<boolean> {
    const task = this.assertActiveTask();
    const response = await this.workerRequest<{ exists: boolean }>(
      "/post-exists",
      { platform: task.platform, postId },
    );
    return response.exists;
  }

  public override async syncStarProfile(
    payload: InstarStarSyncPayload,
  ): Promise<void> {
    this.assertActiveTask();
    const startedAt = Date.now();
    this.log("info", "instar.profile.sync.start", {
      insStarId: payload.insStarId,
      starName: payload.starName,
    });
    await this.starSyncClient.syncStarProfile(payload);
    this.assertActiveTask();
    this.log("info", "instar.profile.sync.done", {
      insStarId: payload.insStarId,
      durationMs: Date.now() - startedAt,
    });
  }

  public override async syncPostDetail(
    payload: InstarPost,
    publishedAt?: string,
  ): Promise<void> {
    const task = this.assertActiveTask();
    const startedAt = Date.now();
    this.log("info", "instar.post.sync.start", {
      postId: payload.insPostId,
    });
    await this.postSyncClient.notifyPostSynced(payload);
    this.assertActiveTask(task);
    await this.workerRequest("/post-result", {
      ...this.leasePayload(task),
      platform: task.platform,
      accountId: task.accountId,
      postId: payload.insPostId,
      publishedAt,
      status: "success",
      payload: { ...payload },
    });
    this.resetNoSuccessWatchdog();
    this.log("info", "instar.post.sync.done", {
      postId: payload.insPostId,
      durationMs: Date.now() - startedAt,
    });
  }

  public override async syncPostFailure(
    postId: string,
    error: string,
  ): Promise<void> {
    const task = this.assertActiveTask();
    this.log("info", "post.failure.submit.start", { postId });
    await this.workerRequest("/post-result", {
      ...this.leasePayload(task),
      platform: task.platform,
      accountId: task.accountId,
      postId,
      status: "failed",
      payload: { error },
    });
    this.log("info", "post.failure.submit.done", { postId });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (
        this.heartbeatInFlight ||
        this.currentTask === null ||
        this.leaseLost
      ) {
        return;
      }
      this.heartbeatInFlight = true;
      void this.sendHeartbeat(this.currentTask)
        .then(() => {
          this.log("info", "task.heartbeat续租成功");
        })
        .catch((error: unknown) => {
          if (error instanceof WorkerApiError && error.status === 409) {
            this.leaseLost = true;
            this.log("error", "task.heartbeat.lease_lost", {
              error: error.message,
            });
          } else {
            this.log("warn", "task.heartbeat.failed", {
              error: errorMessage(error),
            });
          }
        })
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startNoSuccessWatchdog(task: ClaimedAccountTask): void {
    this.stopNoSuccessWatchdog();
    this.noSuccessTimer = setTimeout(() => {
      if (this.currentTask?.id !== task.id) {
        return;
      }

      this.log("error", "account.task.no_success_timeout", {
        taskId: task.id,
        accountId: task.accountId,
        timeoutMs: this.noSuccessTimeoutMs,
      });
      this.stopHeartbeat();
      this.stopNoSuccessWatchdog();
      this.leaseLost = true;
      this.terminateWorker(1);
    }, this.noSuccessTimeoutMs);
  }

  private resetNoSuccessWatchdog(): void {
    const task = this.assertActiveTask();
    this.startNoSuccessWatchdog(task);
  }

  private stopNoSuccessWatchdog(): void {
    if (this.noSuccessTimer !== null) {
      clearTimeout(this.noSuccessTimer);
      this.noSuccessTimer = null;
    }
  }

  private async sendHeartbeat(task: ClaimedAccountTask): Promise<void> {
    await this.workerRequest("/heartbeat", this.leasePayload(task));
  }

  private assertActiveTask(expected?: ClaimedAccountTask): ClaimedAccountTask {
    if (
      this.currentTask === null ||
      this.leaseLost ||
      (expected !== undefined && this.currentTask.id !== expected.id)
    ) {
      throw new Error("账号任务租约已丢失或任务上下文无效");
    }
    return this.currentTask;
  }

  private leasePayload(task: ClaimedAccountTask) {
    return {
      taskId: task.id,
      workerId: this.workerId,
      leaseToken: task.leaseToken,
    };
  }

  private async notifyAccountCompleted(
    accountId: string,
    status: 0 | 1,
  ): Promise<void> {
    if (this.accountClient === undefined) {
      return;
    }
    const startedAt = Date.now();
    this.log("info", "instar.account.callback.start", { status });
    try {
      await this.accountClient.notifyAccountCompleted(
        toInstarAccountCompletedPayload(accountId, status),
      );
      this.log("info", "instar.account.callback.done", {
        status,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.log("warn", "instar.account.callback.failed", {
        status,
        durationMs: Date.now() - startedAt,
        error: errorMessage(error),
      });
    }
  }

  private async workerRequest<T = Record<string, unknown>>(
    path: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.fetchImpl(
      `${this.apiBaseUrl}/internal/workers${path}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    const body = (await response.json().catch(() => ({}))) as
      | WorkerApiErrorPayload
      | T;
    if (!response.ok) {
      const message =
        "error" in (body as WorkerApiErrorPayload) &&
        typeof (body as WorkerApiErrorPayload).error === "string"
          ? (body as WorkerApiErrorPayload).error!
          : `${response.status} ${response.statusText}`;
      throw new WorkerApiError(response.status, message);
    }
    return body as T;
  }
}

export function createGithubActionWorkerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubActionWorker {
  const apiBaseUrl = requiredEnv(
    env,
    "APP_WORKER_API_BASE_URL",
    "WORKER_API_BASE_URL",
  );
  const apiToken = requiredEnv(env, "APP_WORKER_API_TOKEN", "WORKER_API_TOKEN");
  const postSyncUrl = requiredEnv(env, "APP_INSTAR_POST_WEBHOOK_URL");
  const postSyncBearer = optionalEnv(
    env,
    "APP_INSTAR_POST_WEBHOOK_AUTH_BEARER",
  );
  const starSyncUrl = resolveStarSyncUrl(
    optionalEnv(env, "APP_INSTAR_STAR_SYNC_URL"),
    postSyncUrl,
  );
  const starSyncBearer = optionalEnv(env, "APP_INSTAR_STAR_SYNC_AUTH_BEARER");
  const accountWebhookUrl = optionalEnv(env, "APP_INSTAR_WEBHOOK_URL");
  const accountWebhookBearer = optionalEnv(
    env,
    "APP_INSTAR_WEBHOOK_AUTH_BEARER",
  );

  requiredEnv(env, "BUCKET");

  return new GithubActionWorker({
    apiBaseUrl,
    apiToken,
    workerId: createWorkerId(env),
    heartbeatIntervalMs: positiveIntEnv(
      env,
      "APP_WORKER_HEARTBEAT_INTERVAL_MS",
      30_000,
    ),
    noSuccessTimeoutMs: positiveIntEnv(
      env,
      "APP_WORKER_NO_SUCCESS_TIMEOUT_MS",
      DEFAULT_NO_SUCCESS_TIMEOUT_MS,
    ),
    idleWaitMs: positiveIntEnv(env, "APP_WORKER_IDLE_WAIT_MS", 10_000),
    maxEmptyClaims: positiveIntEnv(env, "APP_WORKER_MAX_EMPTY_CLAIMS", 3),
    starSyncClient: new HttpInstarStarSyncClient({
      url: starSyncUrl,
      bearerToken: starSyncBearer,
    }),
    postSyncClient: new HttpInstarPostSyncClient({
      url: postSyncUrl,
      bearerToken: postSyncBearer,
    }),
    ...(accountWebhookUrl
      ? {
          accountClient: new HttpInstarServerClient({
            url: accountWebhookUrl,
            bearerToken: accountWebhookBearer,
          }),
        }
      : {}),
  });
}

if (import.meta.main) {
  await createGithubActionWorkerFromEnv().autoSetup();
}
