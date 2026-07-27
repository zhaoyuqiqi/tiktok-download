import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export interface AccountRow {
  platform: string;
  accountId: string;
  nextRunAt: string;
  lastPostAt: string | null;
  lastVideoId: string | null;
  active: boolean;
}

export interface FetchedPostRow {
  platform: string;
  accountId: string | null;
  postId: string;
  publishedAt: string | null;
  status: string;
  attempts: number;
  fetchedAt: string;
}

export function openDatabase(filePath: string): Database {
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      last_post_at TEXT,
      last_video_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (platform, account_id)
    );

    CREATE TABLE IF NOT EXISTS fetched_posts (
      platform TEXT NOT NULL,
      account_id TEXT,
      post_id TEXT NOT NULL,
      published_at TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (platform, post_id)
    );

    CREATE TABLE IF NOT EXISTS worker_instances (
      worker_id TEXT PRIMARY KEY,
      worker_type TEXT NOT NULL CHECK(worker_type IN ('local', 'github-action')),
      status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'OFFLINE')),
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_tasks (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('due', 'manual')),
      options_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      worker_id TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      result_summary_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_post_results (
      task_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      post_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, post_id),
      FOREIGN KEY (task_id) REFERENCES account_tasks(id)
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_next_run
      ON accounts(next_run_at)
      WHERE active = 1;

    CREATE INDEX IF NOT EXISTS idx_fetched_posts_fetched_at
      ON fetched_posts(fetched_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tasks_active_account
      ON account_tasks(platform, account_id)
      WHERE status IN ('PENDING', 'RUNNING')
         OR (status = 'FAILED' AND next_retry_at IS NOT NULL);

    CREATE INDEX IF NOT EXISTS idx_account_tasks_claimable
      ON account_tasks(status, next_retry_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_account_tasks_lease
      ON account_tasks(status, lease_expires_at);

    CREATE INDEX IF NOT EXISTS idx_worker_instances_status
      ON worker_instances(status, last_seen_at);
  `);

  const fetchedPostColumns = db
    .query("PRAGMA table_info(fetched_posts)")
    .all() as Array<{ name: string }>;
  if (!fetchedPostColumns.some((column) => column.name === "account_id")) {
    db.exec("ALTER TABLE fetched_posts ADD COLUMN account_id TEXT;");
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fetched_posts_account
      ON fetched_posts(platform, account_id);
  `);
}
