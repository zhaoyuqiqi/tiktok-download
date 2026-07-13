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
  > &
    Partial<Pick<StateRepository, "clearFetchedPostsForAccount" | "resetAccountCursor">>;
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

function normalizeAccountIdentifier(body: unknown): string {
  if (typeof body !== "object" || body === null) {
    return "";
  }

  const payload = body as Record<string, unknown>;
  const accountIdRaw = typeof payload.accountId === "string" ? payload.accountId : undefined;
  const starIdRaw = typeof payload.starId === "string" ? payload.starId : undefined;
  return (accountIdRaw ?? starIdRaw ?? "").trim();
}

function parseOptionalIntegerField(
  body: unknown,
  fieldName: string,
): number | undefined | "invalid" {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const payload = body as Record<string, unknown>;
  const raw = payload[fieldName];
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim().length > 0
        ? Number(raw)
        : Number.NaN;

  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function normalizeManualLimit(body: unknown): number | undefined | "invalid" {
  const parsed = parseOptionalIntegerField(body, "limit");
  if (parsed === undefined || parsed === "invalid") {
    return parsed;
  }

  if (parsed < 1 || parsed > 100) {
    return "invalid";
  }

  return parsed;
}

function normalizeCategoryId(body: unknown): number | undefined | "invalid" {
  const parsed = parseOptionalIntegerField(body, "categoryId");
  if (parsed === undefined || parsed === "invalid") {
    return parsed;
  }

  if (parsed < -1) {
    return "invalid";
  }

  return parsed;
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
      const accountId = normalizeAccountIdentifier(body);
      const manualLimit = normalizeManualLimit(body);
      const categoryId = normalizeCategoryId(body);
      const zhName = (body as Record<string, unknown>).zhName as string | undefined;

      if (accountId.length === 0) {
        set.status = 400;
        return { error: "accountId/starId 不能为空" };
      }

      if (manualLimit === "invalid") {
        set.status = 400;
        return { error: "limit 必须是 1~100 的正整数" };
      }

      if (categoryId === "invalid") {
        set.status = 400;
        return { error: "categoryId 必须是大于等于 -1 的整数" };
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

        await options.scheduler.trigger(accountId, {
          limit: manualLimit,
          categoryId,
          zhName
        });
      }

      set.status = 202;
      return {
        accepted: true,
        accountId,
        starId: accountId,
        source: "manual",
        limit: manualLimit ?? 100,
        categoryId,
        zhName
      };
    })
    .post("/accounts/clear-fetched", ({ body, set }) => {
      const accountId = normalizeAccountIdentifier(body);

      if (accountId.length === 0) {
        set.status = 400;
        return { error: "accountId/starId 不能为空" };
      }

      const deletedCount = options.repo?.clearFetchedPostsForAccount?.(platform, accountId) ?? 0;
      options.repo?.resetAccountCursor?.(platform, accountId);

      return {
        cleared: true,
        accountId,
        starId: accountId,
        deletedCount,
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
