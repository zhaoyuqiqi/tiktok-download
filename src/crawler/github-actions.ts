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
  fetchImpl?: FetchLike;
  starSyncClient: InstarStarSyncClient;
  postSyncClient: InstarPostSyncClient;
  accountClient?: InstarServerClient;
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string {
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
  private readonly fetchImpl: FetchLike;
  private readonly starSyncClient: InstarStarSyncClient;
  private readonly postSyncClient: InstarPostSyncClient;
  private readonly accountClient?: InstarServerClient;
  private currentTask: ClaimedAccountTask | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  private leaseLost = false;

  constructor(options: GithubActionWorkerOptions) {
    super(options);
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/g, "");
    this.apiToken = options.apiToken.trim();
    this.workerId = options.workerId.trim();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
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
  }

  protected override async onWorkerStart(): Promise<void> {
    await this.workerRequest("/register", {
      workerId: this.workerId,
      workerType: "github-action",
    });
  }

  protected override async onWorkerEnd(): Promise<void> {
    this.stopHeartbeat();
    try {
      await this.workerRequest("/unregister", { workerId: this.workerId });
    } catch (error) {
      console.warn("github-action worker 注销失败", error);
    }
  }

  protected override async claimTasks(): Promise<ClaimedAccountTask | null> {
    const response = await this.workerRequest<ClaimResponse>("/claim", {
      workerId: this.workerId,
    });
    return response.task;
  }

  protected override async onTaskStart(
    task: ClaimedAccountTask,
  ): Promise<void> {
    this.currentTask = task;
    this.leaseLost = false;
    this.startHeartbeat();
  }

  protected override async onTaskSuccess(
    task: ClaimedAccountTask,
    summary: AccountExecutionSummary,
  ): Promise<void> {
    this.assertActiveTask(task);
    await this.workerRequest("/account-result", {
      ...this.leasePayload(task),
      status: summary.outcome,
      summary,
    });
    await this.notifyAccountCompleted(task.accountId, 1);
  }

  protected override async onTaskFailure(
    task: ClaimedAccountTask,
    error: unknown,
  ): Promise<void> {
    this.assertActiveTask(task);
    await this.workerRequest("/account-result", {
      ...this.leasePayload(task),
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    await this.notifyAccountCompleted(task.accountId, 0);
  }

  protected override async onTaskEnd(
    _task: ClaimedAccountTask,
  ): Promise<void> {
    this.stopHeartbeat();
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
    await this.starSyncClient.syncStarProfile(payload);
    this.assertActiveTask();
  }

  public override async syncPostDetail(
    payload: InstarPost,
    publishedAt?: string,
  ): Promise<void> {
    const task = this.assertActiveTask();
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
  }

  public override async syncPostFailure(
    postId: string,
    error: string,
  ): Promise<void> {
    const task = this.assertActiveTask();
    await this.workerRequest("/post-result", {
      ...this.leasePayload(task),
      platform: task.platform,
      accountId: task.accountId,
      postId,
      status: "failed",
      payload: { error },
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight || this.currentTask === null || this.leaseLost) {
        return;
      }
      this.heartbeatInFlight = true;
      void this.sendHeartbeat(this.currentTask)
        .catch((error: unknown) => {
          if (error instanceof WorkerApiError && error.status === 409) {
            this.leaseLost = true;
          } else {
            console.warn("github-action worker heartbeat 失败", error);
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

  private async sendHeartbeat(task: ClaimedAccountTask): Promise<void> {
    await this.workerRequest("/heartbeat", this.leasePayload(task));
  }

  private assertActiveTask(
    expected?: ClaimedAccountTask,
  ): ClaimedAccountTask {
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
    try {
      await this.accountClient.notifyAccountCompleted(
        toInstarAccountCompletedPayload(accountId, status),
      );
    } catch (error) {
      console.warn("github-action worker 账号回调失败", error);
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
  const apiToken = requiredEnv(
    env,
    "APP_WORKER_API_TOKEN",
    "WORKER_API_TOKEN",
  );
  const postSyncUrl = requiredEnv(env, "APP_INSTAR_POST_WEBHOOK_URL");
  const postSyncBearer = optionalEnv(
    env,
    "APP_INSTAR_POST_WEBHOOK_AUTH_BEARER",
  );
  const starSyncUrl = resolveStarSyncUrl(
    optionalEnv(env, "APP_INSTAR_STAR_SYNC_URL"),
    postSyncUrl,
  );
  const starSyncBearer = optionalEnv(
    env,
    "APP_INSTAR_STAR_SYNC_AUTH_BEARER",
  );
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
