import type { Database } from "bun:sqlite";
import type { AccountRow, FetchedPostRow } from "./db.ts";

interface UpsertAccountInput {
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

interface MarkFetchedPostInput {
  platform: string;
  postId: string;
  publishedAt?: string | null;
  status: string;
  attempts: number;
  fetchedAt: string;
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
  post_id: string;
  published_at: string | null;
  status: string;
  attempts: number;
  fetched_at: string;
}): FetchedPostRow {
  return {
    platform: raw.platform,
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
        `INSERT INTO fetched_posts(platform, post_id, published_at, status, attempts, fetched_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(platform, post_id)
         DO UPDATE SET
           published_at = excluded.published_at,
           status = excluded.status,
           attempts = excluded.attempts,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        input.platform,
        input.postId,
        input.publishedAt ?? null,
        input.status,
        input.attempts,
        input.fetchedAt,
      );

    const row = this.db
      .query(
        `SELECT platform, post_id, published_at, status, attempts, fetched_at
         FROM fetched_posts
         WHERE platform = ?1 AND post_id = ?2`,
      )
      .get(input.platform, input.postId) as
      | {
          platform: string;
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
}
