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
      post_id TEXT NOT NULL,
      published_at TEXT,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (platform, post_id)
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_next_run
      ON accounts(next_run_at)
      WHERE active = 1;

    CREATE INDEX IF NOT EXISTS idx_fetched_posts_fetched_at
      ON fetched_posts(fetched_at);
  `);
}
