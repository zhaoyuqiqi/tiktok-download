import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AccountRow, FetchedPostRow } from "./db.ts";
import type {
  AccountTask,
  AccountTaskOptions,
  AccountTaskSource,
  ClaimedAccountTask,
  TaskPostResult,
  WorkerRegistration,
  WorkerType,
} from "../workers/protocol.ts";

export interface UpsertAccountInput {
  platform: string;
  accountId: string;
  nextRunAt: string;
  lastPostAt?: string | null;
  lastVideoId?: string | null;
  active?: boolean;
}

interface ListDueAccountsInput {
  platform: string;
  nowIso: string;
  limit: number;
}

export interface MarkFetchedPostInput {
  platform: string;
  accountId?: string | null;
  postId: string;
  publishedAt?: string | null;
  status: string;
  attempts: number;
  fetchedAt: string;
}

export interface EnqueueAccountTaskInput {
  platform: string;
  accountId: string;
  source: AccountTaskSource;
  options?: AccountTaskOptions;
  nowIso: string;
  maxRetries?: number;
}

export interface EnqueueAccountTaskResult {
  task: AccountTask;
  created: boolean;
}

export interface ClaimAccountTaskInput {
  workerId: string;
  nowIso: string;
  leaseSeconds: number;
  concurrency: number;
}

export interface TaskLeaseInput {
  taskId: string;
  workerId: string;
  leaseToken: string;
  nowIso: string;
}

export interface CompleteAccountTaskInput extends TaskLeaseInput {
  summary?: Record<string, unknown>;
  accountUpdate?: UpsertAccountInput;
}

export interface FailAccountTaskInput extends TaskLeaseInput {
  error: string;
}

export interface RecordTaskPostResultInput extends TaskLeaseInput {
  platform: string;
  accountId: string;
  postId: string;
  status: "success" | "failed";
  payload: Record<string, unknown>;
}

interface RawAccountTask {
  id: string;
  platform: string;
  account_id: string;
  source: AccountTaskSource;
  options_json: string;
  status: AccountTask["status"];
  retry_count: number;
  max_retries: number;
  next_retry_at: string | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  result_summary_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

const ACCOUNT_TASK_COLUMNS = `
  id, platform, account_id, source, options_json, status, retry_count, max_retries,
  next_retry_at, worker_id, lease_token, lease_expires_at, result_summary_json,
  last_error, created_at, updated_at, started_at, completed_at
`;

const RETRY_BACKOFF_MS = [3 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const TERMINAL_FAILURE_DELAY_MS = 60 * 60_000;

function parseJsonRecord(raw: string | null): Record<string, unknown> | null {
  if (raw === null) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toAccountTask(raw: RawAccountTask): AccountTask {
  return {
    id: raw.id,
    platform: raw.platform,
    accountId: raw.account_id,
    source: raw.source,
    options: (parseJsonRecord(raw.options_json) ?? {}) as AccountTaskOptions,
    status: raw.status,
    retryCount: raw.retry_count,
    maxRetries: raw.max_retries,
    nextRetryAt: raw.next_retry_at,
    workerId: raw.worker_id,
    leaseToken: raw.lease_token,
    leaseExpiresAt: raw.lease_expires_at,
    resultSummary: parseJsonRecord(raw.result_summary_json),
    lastError: raw.last_error,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
  };
}

function addSeconds(nowIso: string, seconds: number): string {
  const timestamp = Date.parse(nowIso);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`时间格式无效: ${nowIso}`);
  }
  return new Date(timestamp + seconds * 1000).toISOString();
}

function toAccountRow(raw: {
  platform: string;
  account_id: string;
  next_run_at: string;
  last_post_at: string | null;
  last_video_id: string | null;
  active: number;
}): AccountRow {
  return {
    platform: raw.platform,
    accountId: raw.account_id,
    nextRunAt: raw.next_run_at,
    lastPostAt: raw.last_post_at,
    lastVideoId: raw.last_video_id,
    active: raw.active === 1,
  };
}

function toFetchedPostRow(raw: {
  platform: string;
  account_id: string | null;
  post_id: string;
  published_at: string | null;
  status: string;
  attempts: number;
  fetched_at: string;
}): FetchedPostRow {
  return {
    platform: raw.platform,
    accountId: raw.account_id,
    postId: raw.post_id,
    publishedAt: raw.published_at,
    status: raw.status,
    attempts: raw.attempts,
    fetchedAt: raw.fetched_at,
  };
}

export class StateRepository {
  constructor(private readonly db: Database) {}

  getAccount(platform: string, accountId: string): AccountRow | null {
    const row = this.db
      .query(
        `SELECT platform, account_id, next_run_at, last_post_at, last_video_id, active
         FROM accounts
         WHERE platform = ?1 AND account_id = ?2`,
      )
      .get(platform, accountId) as
      | {
          platform: string;
          account_id: string;
          next_run_at: string;
          last_post_at: string | null;
          last_video_id: string | null;
          active: number;
        }
      | null;

    if (row === null) {
      return null;
    }

    return toAccountRow(row);
  }

  upsertAccount(input: UpsertAccountInput): AccountRow {
    this.db
      .query(
        `INSERT INTO accounts(platform, account_id, next_run_at, last_post_at, last_video_id, active)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(platform, account_id)
         DO UPDATE SET
           next_run_at = excluded.next_run_at,
           last_post_at = excluded.last_post_at,
           last_video_id = excluded.last_video_id,
           active = excluded.active`,
      )
      .run(
        input.platform,
        input.accountId,
        input.nextRunAt,
        input.lastPostAt ?? null,
        input.lastVideoId ?? null,
        (input.active ?? true) ? 1 : 0,
      );

    const saved = this.getAccount(input.platform, input.accountId);
    if (saved === null) {
      throw new Error("upsertAccount 后未读取到记录");
    }

    return saved;
  }

  listDueAccounts(input: ListDueAccountsInput): AccountRow[] {
    const rows = this.db
      .query(
        `SELECT platform, account_id, next_run_at, last_post_at, last_video_id, active
         FROM accounts
         WHERE platform = ?1
           AND active = 1
           AND next_run_at <= ?2
           AND NOT EXISTS (
             SELECT 1 FROM account_tasks task
             WHERE task.platform = accounts.platform
               AND task.account_id = accounts.account_id
               AND (
                 task.status IN ('PENDING', 'RUNNING')
                 OR (task.status = 'FAILED' AND task.next_retry_at IS NOT NULL)
               )
           )
         ORDER BY next_run_at ASC
         LIMIT ?3`,
      )
      .all(input.platform, input.nowIso, input.limit) as Array<{
      platform: string;
      account_id: string;
      next_run_at: string;
      last_post_at: string | null;
      last_video_id: string | null;
      active: number;
    }>;

    return rows.map((row) => toAccountRow(row));
  }

  listAccounts(platform: string, limit = 200): AccountRow[] {
    const rows = this.db
      .query(
        `SELECT platform, account_id, next_run_at, last_post_at, last_video_id, active
         FROM accounts
         WHERE platform = ?1
         ORDER BY active DESC, next_run_at ASC, account_id ASC
         LIMIT ?2`,
      )
      .all(platform, limit) as Array<{
      platform: string;
      account_id: string;
      next_run_at: string;
      last_post_at: string | null;
      last_video_id: string | null;
      active: number;
    }>;

    return rows.map((row) => toAccountRow(row));
  }

  setAccountActive(platform: string, accountId: string, active: boolean): AccountRow | null {
    this.db
      .query(
        `UPDATE accounts
         SET active = ?3
         WHERE platform = ?1 AND account_id = ?2`,
      )
      .run(platform, accountId, active ? 1 : 0);

    return this.getAccount(platform, accountId);
  }

  countAccounts(platform: string, active?: boolean): number {
    if (active === undefined) {
      const row = this.db
        .query(
          `SELECT COUNT(1) AS total
           FROM accounts
           WHERE platform = ?1`,
        )
        .get(platform) as { total: number };
      return row.total;
    }

    const row = this.db
      .query(
        `SELECT COUNT(1) AS total
         FROM accounts
         WHERE platform = ?1 AND active = ?2`,
      )
      .get(platform, active ? 1 : 0) as { total: number };
    return row.total;
  }

  countDueAccounts(platform: string, nowIso: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(1) AS total
         FROM accounts
         WHERE platform = ?1
           AND active = 1
           AND next_run_at <= ?2`,
      )
      .get(platform, nowIso) as { total: number };
    return row.total;
  }

  countFetchedPosts(platform: string): number {
    const row = this.db
      .query(
        `SELECT COUNT(1) AS total
         FROM fetched_posts
         WHERE platform = ?1`,
      )
      .get(platform) as { total: number };
    return row.total;
  }

  isFetched(platform: string, postId: string): boolean {
    const row = this.db
      .query(
        `SELECT 1 AS exists_flag
         FROM fetched_posts
         WHERE platform = ?1 AND post_id = ?2`,
      )
      .get(platform, postId) as { exists_flag: number } | null;

    return row !== null;
  }

  markFetched(input: MarkFetchedPostInput): FetchedPostRow {
    this.db
      .query(
        `INSERT INTO fetched_posts(platform, account_id, post_id, published_at, status, attempts, fetched_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(platform, post_id)
         DO UPDATE SET
           account_id = excluded.account_id,
           published_at = excluded.published_at,
           status = excluded.status,
           attempts = excluded.attempts,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        input.platform,
        input.accountId ?? null,
        input.postId,
        input.publishedAt ?? null,
        input.status,
        input.attempts,
        input.fetchedAt,
      );

    const row = this.db
      .query(
        `SELECT platform, account_id, post_id, published_at, status, attempts, fetched_at
         FROM fetched_posts
         WHERE platform = ?1 AND post_id = ?2`,
      )
      .get(input.platform, input.postId) as
      | {
          platform: string;
          account_id: string | null;
          post_id: string;
          published_at: string | null;
          status: string;
          attempts: number;
          fetched_at: string;
        }
      | null;

    if (row === null) {
      throw new Error("markFetched 后未读取到记录");
    }

    return toFetchedPostRow(row);
  }

  clearFetchedPostsForAccount(platform: string, accountId: string): number {
    const result = this.db
      .query(
        `DELETE FROM fetched_posts
         WHERE platform = ?1 AND account_id = ?2`,
      )
      .run(platform, accountId);

    return result.changes;
  }

  resetAccountCursor(platform: string, accountId: string): AccountRow | null {
    this.db
      .query(
        `UPDATE accounts
         SET last_post_at = NULL,
             last_video_id = NULL
         WHERE platform = ?1 AND account_id = ?2`,
      )
      .run(platform, accountId);

    return this.getAccount(platform, accountId);
  }

  getAccountTask(taskId: string): AccountTask | null {
    const row = this.db
      .query(`SELECT ${ACCOUNT_TASK_COLUMNS} FROM account_tasks WHERE id = ?1`)
      .get(taskId) as RawAccountTask | null;
    return row === null ? null : toAccountTask(row);
  }

  enqueueAccountTask(input: EnqueueAccountTaskInput): EnqueueAccountTaskResult {
    const execute = this.db.transaction(() => {
      const existing = this.db
        .query(
          `SELECT ${ACCOUNT_TASK_COLUMNS}
           FROM account_tasks
           WHERE platform = ?1 AND account_id = ?2
             AND (
               status IN ('PENDING', 'RUNNING')
               OR (status = 'FAILED' AND next_retry_at IS NOT NULL)
             )
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(input.platform, input.accountId) as RawAccountTask | null;

      if (existing !== null) {
        if (input.source === "manual" && existing.status !== "RUNNING") {
          this.db
            .query(
              `UPDATE account_tasks
               SET source = 'manual', options_json = ?2, status = 'PENDING',
                   next_retry_at = NULL, updated_at = ?3
               WHERE id = ?1`,
            )
            .run(
              existing.id,
              JSON.stringify(input.options ?? {}),
              input.nowIso,
            );
          const promoted = this.getAccountTask(existing.id);
          if (promoted === null) {
            throw new Error("手动任务提升后未读取到记录");
          }
          return { task: promoted, created: false };
        }
        return { task: toAccountTask(existing), created: false };
      }

      const taskId = randomUUID();
      this.db
        .query(
          `INSERT INTO account_tasks(
             id, platform, account_id, source, options_json, status, retry_count,
             max_retries, created_at, updated_at
           ) VALUES(?1, ?2, ?3, ?4, ?5, 'PENDING', 0, ?6, ?7, ?7)`,
        )
        .run(
          taskId,
          input.platform,
          input.accountId,
          input.source,
          JSON.stringify(input.options ?? {}),
          input.maxRetries ?? 3,
          input.nowIso,
        );

      const task = this.getAccountTask(taskId);
      if (task === null) {
        throw new Error("创建账号任务后未读取到记录");
      }
      return { task, created: true };
    });

    return execute.immediate();
  }

  recoverAccountTasks(nowIso: string): number {
    const execute = this.db.transaction(() =>
      this.recoverAccountTasksWithinTransaction(nowIso),
    );
    return execute.immediate();
  }

  private recoverAccountTasksWithinTransaction(nowIso: string): number {
    const expired = this.db
      .query(
        `UPDATE account_tasks
         SET status = 'PENDING', worker_id = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = ?1
         WHERE status = 'RUNNING' AND lease_expires_at <= ?1`,
      )
      .run(nowIso).changes;
    const retryable = this.db
      .query(
        `UPDATE account_tasks
         SET status = 'PENDING', next_retry_at = NULL, updated_at = ?1
         WHERE status = 'FAILED' AND next_retry_at <= ?1`,
      )
      .run(nowIso).changes;
    return expired + retryable;
  }

  countClaimableAccountTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(1) AS total FROM account_tasks WHERE status = 'PENDING'`,
      )
      .get() as { total: number };
    return row.total;
  }

  countRunningAccountTasks(): number {
    const row = this.db
      .query(
        `SELECT COUNT(1) AS total FROM account_tasks WHERE status = 'RUNNING'`,
      )
      .get() as { total: number };
    return row.total;
  }

  claimAccountTask(input: ClaimAccountTaskInput): ClaimedAccountTask | null {
    if (input.concurrency <= 0 || input.leaseSeconds <= 0) {
      throw new Error("任务并发数和租约时长必须为正数");
    }

    const execute = this.db.transaction(() => {
      this.recoverAccountTasksWithinTransaction(input.nowIso);

      if (this.countRunningAccountTasks() >= input.concurrency) {
        return null;
      }

      const pending = this.db
        .query(
          `SELECT ${ACCOUNT_TASK_COLUMNS}
           FROM account_tasks
           WHERE status = 'PENDING'
           ORDER BY CASE source WHEN 'manual' THEN 0 ELSE 1 END, created_at ASC
           LIMIT 1`,
        )
        .get() as RawAccountTask | null;
      if (pending === null) {
        return null;
      }

      const leaseToken = randomUUID();
      const leaseExpiresAt = addSeconds(input.nowIso, input.leaseSeconds);
      const result = this.db
        .query(
          `UPDATE account_tasks
           SET status = 'RUNNING', worker_id = ?2, lease_token = ?3,
               lease_expires_at = ?4, started_at = COALESCE(started_at, ?5),
               updated_at = ?5, last_error = NULL
           WHERE id = ?1 AND status = 'PENDING'`,
        )
        .run(
          pending.id,
          input.workerId,
          leaseToken,
          leaseExpiresAt,
          input.nowIso,
        );
      if (result.changes !== 1) {
        return null;
      }

      const claimed = this.getAccountTask(pending.id);
      if (
        claimed === null ||
        claimed.status !== "RUNNING" ||
        claimed.workerId === null ||
        claimed.leaseToken === null ||
        claimed.leaseExpiresAt === null
      ) {
        throw new Error("领取账号任务后状态无效");
      }
      return claimed as ClaimedAccountTask;
    });
    return execute.immediate();
  }

  heartbeatAccountTask(
    input: TaskLeaseInput,
    leaseSeconds: number,
  ): AccountTask | null {
    const leaseExpiresAt = addSeconds(input.nowIso, leaseSeconds);
    const result = this.db
      .query(
        `UPDATE account_tasks
         SET lease_expires_at = ?5, updated_at = ?4
         WHERE id = ?1 AND worker_id = ?2 AND lease_token = ?3
           AND status = 'RUNNING' AND lease_expires_at > ?4`,
      )
      .run(
        input.taskId,
        input.workerId,
        input.leaseToken,
        input.nowIso,
        leaseExpiresAt,
      );
    return result.changes === 1 ? this.getAccountTask(input.taskId) : null;
  }

  completeAccountTask(input: CompleteAccountTaskInput): AccountTask | null {
    const execute = this.db.transaction(() => {
      const existing = this.getAccountTask(input.taskId);
      if (existing?.status === "SUCCESS") {
        return existing;
      }

      const result = this.db
        .query(
          `UPDATE account_tasks
           SET status = 'SUCCESS', result_summary_json = ?5, completed_at = ?4,
               updated_at = ?4, worker_id = NULL, lease_token = NULL,
               lease_expires_at = NULL, next_retry_at = NULL
           WHERE id = ?1 AND worker_id = ?2 AND lease_token = ?3
             AND status = 'RUNNING' AND lease_expires_at > ?4`,
        )
        .run(
          input.taskId,
          input.workerId,
          input.leaseToken,
          input.nowIso,
          JSON.stringify(input.summary ?? {}),
        );
      if (result.changes !== 1) {
        return null;
      }
      if (input.accountUpdate !== undefined) {
        this.upsertAccount(input.accountUpdate);
      }
      return this.getAccountTask(input.taskId);
    });
    return execute.immediate();
  }

  failAccountTask(input: FailAccountTaskInput): AccountTask | null {
    const execute = this.db.transaction(() => {
      const task = this.getAccountTask(input.taskId);
      if (task?.status === "FAILED" || task?.status === "SUCCESS") {
        return task;
      }
      if (
        task === null ||
        task.status !== "RUNNING" ||
        task.workerId !== input.workerId ||
        task.leaseToken !== input.leaseToken ||
        task.leaseExpiresAt === null ||
        task.leaseExpiresAt <= input.nowIso
      ) {
        return null;
      }

      const canRetry = task.retryCount < task.maxRetries;
      const nextRetryCount = canRetry ? task.retryCount + 1 : task.retryCount;
      const delay =
        RETRY_BACKOFF_MS[
          Math.min(task.retryCount, RETRY_BACKOFF_MS.length - 1)
        ] ?? 0;
      const nextRetryAt = canRetry
        ? new Date(Date.parse(input.nowIso) + delay).toISOString()
        : null;

      this.db
        .query(
          `UPDATE account_tasks
           SET status = 'FAILED', retry_count = ?5, next_retry_at = ?6,
               last_error = ?7, completed_at = CASE WHEN ?6 IS NULL THEN ?4 ELSE NULL END,
               updated_at = ?4, worker_id = NULL, lease_token = NULL,
               lease_expires_at = NULL
           WHERE id = ?1 AND worker_id = ?2 AND lease_token = ?3 AND status = 'RUNNING'`,
        )
        .run(
          input.taskId,
          input.workerId,
          input.leaseToken,
          input.nowIso,
          nextRetryCount,
          nextRetryAt,
          input.error,
        );
      if (!canRetry) {
        const nextRunAt = new Date(
          Date.parse(input.nowIso) + TERMINAL_FAILURE_DELAY_MS,
        ).toISOString();
        this.db
          .query(
            `UPDATE accounts SET next_run_at = ?3
             WHERE platform = ?1 AND account_id = ?2`,
          )
          .run(task.platform, task.accountId, nextRunAt);
      }
      return this.getAccountTask(input.taskId);
    });
    return execute.immediate();
  }

  registerWorker(
    workerId: string,
    workerType: WorkerType,
    nowIso: string,
  ): WorkerRegistration {
    this.db
      .query(
        `INSERT INTO worker_instances(worker_id, worker_type, status, registered_at, last_seen_at)
         VALUES(?1, ?2, 'ACTIVE', ?3, ?3)
         ON CONFLICT(worker_id) DO UPDATE SET
           worker_type = excluded.worker_type,
           status = 'ACTIVE',
           last_seen_at = excluded.last_seen_at`,
      )
      .run(workerId, workerType, nowIso);
    return this.getWorker(workerId) as WorkerRegistration;
  }

  touchWorker(workerId: string, nowIso: string): boolean {
    return (
      this.db
        .query(
          `UPDATE worker_instances SET status = 'ACTIVE', last_seen_at = ?2 WHERE worker_id = ?1`,
        )
        .run(workerId, nowIso).changes === 1
    );
  }

  finishWorker(workerId: string, nowIso: string): boolean {
    return (
      this.db
        .query(
          `UPDATE worker_instances SET status = 'OFFLINE', last_seen_at = ?2 WHERE worker_id = ?1`,
        )
        .run(workerId, nowIso).changes === 1
    );
  }

  getWorker(workerId: string): WorkerRegistration | null {
    const row = this.db
      .query(
        `SELECT worker_id, worker_type, status, registered_at, last_seen_at
         FROM worker_instances WHERE worker_id = ?1`,
      )
      .get(workerId) as {
      worker_id: string;
      worker_type: WorkerType;
      status: "ACTIVE" | "OFFLINE";
      registered_at: string;
      last_seen_at: string;
    } | null;
    return row === null
      ? null
      : {
          workerId: row.worker_id,
          workerType: row.worker_type,
          status: row.status,
          registeredAt: row.registered_at,
          lastSeenAt: row.last_seen_at,
        };
  }

  recordTaskPostResult(
    input: RecordTaskPostResultInput,
  ): TaskPostResult | null {
    const task = this.getAccountTask(input.taskId);
    if (
      task === null ||
      task.status !== "RUNNING" ||
      task.workerId !== input.workerId ||
      task.leaseToken !== input.leaseToken ||
      task.leaseExpiresAt === null ||
      task.leaseExpiresAt <= input.nowIso ||
      task.platform !== input.platform ||
      task.accountId !== input.accountId
    ) {
      return null;
    }

    this.db
      .query(
        `INSERT INTO task_post_results(
           task_id, platform, account_id, post_id, status, payload_json, created_at, updated_at
         ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         ON CONFLICT(task_id, post_id) DO UPDATE SET
           status = excluded.status,
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        input.taskId,
        input.platform,
        input.accountId,
        input.postId,
        input.status,
        JSON.stringify(input.payload),
        input.nowIso,
      );

    const row = this.db
      .query(
        `SELECT task_id, platform, account_id, post_id, status, payload_json, created_at, updated_at
         FROM task_post_results WHERE task_id = ?1 AND post_id = ?2`,
      )
      .get(input.taskId, input.postId) as {
      task_id: string;
      platform: string;
      account_id: string;
      post_id: string;
      status: "success" | "failed";
      payload_json: string;
      created_at: string;
      updated_at: string;
    };
    return {
      taskId: row.task_id,
      platform: row.platform,
      accountId: row.account_id,
      postId: row.post_id,
      status: row.status,
      payload: parseJsonRecord(row.payload_json) ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
