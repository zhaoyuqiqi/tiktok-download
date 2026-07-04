import { Elysia } from "elysia";
import type { DueScheduler } from "./scheduling/dueScheduler.ts";
import type { StateRepository } from "./storage/repository.ts";

export interface ServiceStatus {
  scheduler: {
    runningCount: number;
  };
  accounts: {
    total: number;
    active: number;
    inactive: number;
    due: number;
    items: Array<{ accountId: string; nextRunAt: string; active: boolean }>;
  };
  fetched: {
    total: number;
  };
  updatedAt: string;
}

export interface CreateAppOptions {
  platform?: string;
  scheduler?: Pick<DueScheduler, "runningCount" | "trigger">;
  repo?: Pick<
    StateRepository,
    "getAccount" | "upsertAccount" | "listAccounts" | "countAccounts" | "countDueAccounts" | "countFetchedPosts"
  >;
  now?: () => Date;
}

function buildDefaultStatus(now: Date): ServiceStatus {
  return {
    scheduler: { runningCount: 0 },
    accounts: {
      total: 0,
      active: 0,
      inactive: 0,
      due: 0,
      items: [],
    },
    fetched: { total: 0 },
    updatedAt: now.toISOString(),
  };
}

export function createApp(options: CreateAppOptions = {}) {
  const platform = options.platform ?? "tiktok";
  const now = options.now ?? (() => new Date());

  return new Elysia()
    .get("/health", () => ({
      status: "ok",
      service: "tiktok-downloader",
      timestamp: now().toISOString(),
    }))
    .post("/fetch", async ({ body, set }) => {
      const accountIdRaw =
        typeof body === "object" && body !== null && "accountId" in body
          ? (body as { accountId?: unknown }).accountId
          : undefined;
      const accountId = typeof accountIdRaw === "string" ? accountIdRaw.trim() : "";

      if (accountId.length === 0) {
        set.status = 400;
        return { error: "accountId 不能为空" };
      }

      if (options.repo !== undefined && options.scheduler !== undefined) {
        const existing = options.repo.getAccount(platform, accountId);
        if (existing === null) {
          options.repo.upsertAccount({
            platform,
            accountId,
            nextRunAt: now().toISOString(),
            active: true,
          });
        } else if (!existing.active) {
          options.repo.upsertAccount({
            platform,
            accountId,
            nextRunAt: existing.nextRunAt,
            lastPostAt: existing.lastPostAt,
            lastVideoId: existing.lastVideoId,
            active: true,
          });
        }

        await options.scheduler.trigger(accountId);
      }

      set.status = 202;
      return {
        accepted: true,
        accountId,
        source: "manual",
      };
    })
    .get("/status", () => {
      const current = now();
      if (options.repo === undefined || options.scheduler === undefined) {
        return buildDefaultStatus(current);
      }

      const items = options.repo
        .listAccounts(platform, 100)
        .map((item) => ({ accountId: item.accountId, nextRunAt: item.nextRunAt, active: item.active }));

      return {
        scheduler: {
          runningCount: options.scheduler.runningCount,
        },
        accounts: {
          total: options.repo.countAccounts(platform),
          active: options.repo.countAccounts(platform, true),
          inactive: options.repo.countAccounts(platform, false),
          due: options.repo.countDueAccounts(platform, current.toISOString()),
          items,
        },
        fetched: {
          total: options.repo.countFetchedPosts(platform),
        },
        updatedAt: current.toISOString(),
      } as ServiceStatus;
    });
}
