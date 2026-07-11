import { join } from "node:path";
import { loadServiceConfig } from "./config.ts";
import { AccountSourceClient } from "./integration/accountSourceClient.ts";
import {
  HttpInstarPostSyncClient,
  HttpInstarServerClient,
  HttpInstarStarSyncClient,
  NoopInstarServerClient,
  toInstarAccountCompletedPayload,
  toInstarPostSyncedPayload,
} from "./integration/instarServer.ts";
import { syncTikTokProfileBeforeFetch } from "./integration/tiktokProfileSync.ts";
import { debugLog, isDebugEnabled } from "./logging/debugLogger.ts";
import { runAccountIngest, type MediaPipelineOptions } from "./pipeline/accountIngest.ts";
import { TikTokAdapter } from "./platforms/tiktokAdapter.ts";
import { reconcileAccounts } from "./scheduling/accountReconciler.ts";
import { DueScheduler } from "./scheduling/dueScheduler.ts";
import { createApp } from "./server.ts";
import { initSchema, openDatabase } from "./storage/db.ts";
import { StateRepository } from "./storage/repository.ts";
import { uploader } from "./upload/uploader.ts";
import { YtDlpRunner } from "./ytdlp-manager/runner.ts";
import { YtDlpService } from "./ytdlp-manager/ytDlpService.ts";

function createTraceId(accountId: string, source: "due" | "manual"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${source}-${accountId}-${rand}`;
}

export function assertRequiredWebhookEnv(env: NodeJS.ProcessEnv): {
  accountWebhookUrl: string;
  accountWebhookBearer: string;
  postWebhookUrl: string;
  postWebhookBearer: string;
} {
  const accountWebhookUrl = env.APP_INSTAR_WEBHOOK_URL?.trim() ?? "";
  const accountWebhookBearer = env.APP_INSTAR_WEBHOOK_AUTH_BEARER?.trim() ?? "";
  const postWebhookUrl = env.APP_INSTAR_POST_WEBHOOK_URL?.trim() ?? "";
  const postWebhookBearer = env.APP_INSTAR_POST_WEBHOOK_AUTH_BEARER?.trim() ?? "";

  if (postWebhookUrl.length === 0) {
    throw new Error("APP_INSTAR_POST_WEBHOOK_URL 未配置：该变量为必填，缺失时服务拒绝启动");
  }

  return {
    accountWebhookUrl,
    accountWebhookBearer,
    postWebhookUrl,
    postWebhookBearer,
  };
}

function resolveStarSyncUrl(explicitUrl: string, postWebhookUrl: string): string {
  if (explicitUrl.length > 0) {
    return explicitUrl;
  }

  if (postWebhookUrl.length === 0) {
    return "";
  }

  try {
    const u = new URL(postWebhookUrl);
    u.pathname = "/star/api/sync";
    u.search = "";
    return u.toString();
  } catch {
    return "";
  }
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3999);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT 无效: ${process.env.PORT ?? "(空)"}`);
  }

  const config = loadServiceConfig();
  const dbPath = join(config.dataDir, "state.db");
  const db = openDatabase(dbPath);
  initSchema(db);
  const repo = new StateRepository(db);

  const platform = "tiktok";
  const ytDlpService = new YtDlpService();
  let adapterPromise: Promise<TikTokAdapter> | null = null;
  const getAdapter = async (): Promise<TikTokAdapter> => {
    if (adapterPromise === null) {
      adapterPromise = ytDlpService
        .getBinaryPath()
        .then((binPath) => new TikTokAdapter(new YtDlpRunner(binPath)));
    }
    return adapterPromise;
  };

  let profileRunnerPromise: Promise<YtDlpRunner> | null = null;
  const getProfileRunner = async (): Promise<YtDlpRunner> => {
    if (profileRunnerPromise === null) {
      profileRunnerPromise = ytDlpService
        .getPatchedProfileRunnerPath()
        .then((binPath) => new YtDlpRunner(binPath));
    }
    return profileRunnerPromise;
  };

  const cosConfigured =
    config.cos.bucket.length > 0 &&
    config.cos.region.length > 0;

  if (!cosConfigured) {
    throw new Error("COS 配置不完整：请至少配置 COS_BUCKET/COS_REGION");
  }

  const mediaPipeline: MediaPipelineOptions = {
    cosClient: uploader,
    bucket: config.cos.bucket,
    region: config.cos.region,
    keyPrefix: config.cos.keyPrefix,
  };

  const {
    accountWebhookUrl: instarWebhookUrl,
    accountWebhookBearer: instarWebhookBearer,
    postWebhookUrl: instarPostWebhookUrl,
    postWebhookBearer: instarPostWebhookBearer,
  } = assertRequiredWebhookEnv(process.env);

  const instarClient =
    instarWebhookUrl.length > 0
      ? new HttpInstarServerClient({
          url: instarWebhookUrl,
          bearerToken: instarWebhookBearer,
        })
      : new NoopInstarServerClient();

  const instarPostSyncClient = new HttpInstarPostSyncClient({
    url: instarPostWebhookUrl,
    bearerToken: instarPostWebhookBearer,
  });

  const instarStarSyncUrl = resolveStarSyncUrl(
    process.env.APP_INSTAR_STAR_SYNC_URL?.trim() ?? "",
    instarPostWebhookUrl,
  );
  const instarStarSyncBearer = process.env.APP_INSTAR_STAR_SYNC_AUTH_BEARER?.trim() ?? "";

  const instarStarSyncClient =
    instarStarSyncUrl.length > 0
      ? new HttpInstarStarSyncClient({
          url: instarStarSyncUrl,
          bearerToken: instarStarSyncBearer,
        })
      : null;

  const dueScheduler = new DueScheduler({
    concurrency: config.globalConcurrency,
    async listDueAccounts(limit) {
      return repo.listDueAccounts({
        platform,
        nowIso: new Date().toISOString(),
        limit,
      });
    },
    async runAccount(accountId, source, options) {
      const traceId = createTraceId(accountId, source);
      debugLog("run_account.start", {
        traceId,
        platform,
        accountId,
        source,
      });

      try {
        const adapter = await getAdapter();
        const result = await runAccountIngest({
          platform,
          accountId,
          source,
          repo,
          adapter,
          media: mediaPipeline,
          proxy: config.proxy,
          manualLimit: source === "manual" ? options?.limit : undefined,
          manualCategoryId: source === "manual" ? options?.categoryId : undefined,
          manualZhName: source === "manual" ? options?.zhName : undefined,
          traceId,
          beforeFetchPosts:
            instarStarSyncClient !== null
              ? async (beforeFetchInput) => {
                  await syncTikTokProfileBeforeFetch(
                    {
                      accountId: beforeFetchInput.accountId,
                      proxy: beforeFetchInput.proxy,
                      traceId: beforeFetchInput.traceId,
                      categoryId: beforeFetchInput.categoryId,
                      zhName: beforeFetchInput.zhName,
                    },
                    {
                      syncClient: instarStarSyncClient,
                      runner: await getProfileRunner(),
                      avatarUpload: {
                        cosClient: uploader,
                        bucket: config.cos.bucket,
                        region: config.cos.region,
                        keyPrefix: config.cos.keyPrefix,
                      },
                    },
                  );
                }
              : undefined,
          onPostSynced: async (event) => {
            await instarPostSyncClient.notifyPostSynced(
              toInstarPostSyncedPayload({
                platform: event.platform,
                source: event.source,
                starId: event.starId,
                postId: event.postId,
                sourceUrl: event.sourceUrl,
                mediaType: event.mediaType,
                videoUrl: event.videoUrl,
                thumbnailUrl: event.thumbnailUrl,
                publishedAt: event.publishedAt,
                title: event.title,
                description: event.description,
                authorHandle: event.authorHandle,
                rawDetail: event.rawDetail,
              }),
            );
          },
        });

        try {
          await instarClient.notifyAccountCompleted(toInstarAccountCompletedPayload(accountId, 1));
        } catch (callbackError) {
          debugLog("instar.callback.failed", {
            traceId,
            accountId,
            status: 1,
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        }

        debugLog("run_account.done", {
          traceId,
          platform,
          accountId,
          source,
          result,
        });
      } catch (error) {
        try {
          await instarClient.notifyAccountCompleted(toInstarAccountCompletedPayload(accountId, 0));
        } catch (callbackError) {
          debugLog("instar.callback.failed", {
            traceId,
            accountId,
            status: 0,
            error: callbackError instanceof Error ? callbackError.message : String(callbackError),
          });
        }

        debugLog("run_account.failed", {
          traceId,
          accountId,
          source,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  });

  setInterval(() => {
    void dueScheduler.tick();
  }, config.fetchIntervalSeconds * 1000);

  const accountSourceUrl = process.env.APP_ACCOUNT_SOURCE_URL?.trim() ?? "";
  const accountSourceBearer = process.env.APP_ACCOUNT_SOURCE_AUTH_BEARER?.trim() ?? "";
  const accountSourceClient =
    accountSourceUrl.length > 0
      ? new AccountSourceClient({
          url: accountSourceUrl,
          bearerToken: accountSourceBearer,
        })
      : null;

  setInterval(() => {
    if (accountSourceClient === null) {
      return;
    }

    void (async () => {
      debugLog("reconcile.start", { platform });
      const accountIds = await accountSourceClient.fetchAccounts();
      const result = reconcileAccounts(repo, {
        platform,
        accountIds,
      });

      debugLog("reconcile.done", { platform, result });
    })().catch((error) => {
      debugLog("reconcile.failed", {
        platform,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.accountReconcileIntervalSeconds * 1000);

  const app = createApp({
    platform,
    repo,
    scheduler: dueScheduler,
  });

  app.listen({
    hostname: host,
    port,
  });

  debugLog("service.start", {
    url: `http://${host}:${port}`,
    debugEnabled: isDebugEnabled(),
  });

  debugLog("service.config", {
    fetchIntervalSeconds: config.fetchIntervalSeconds,
    accountReconcileIntervalSeconds: config.accountReconcileIntervalSeconds,
    globalConcurrency: config.globalConcurrency,
    proxy: config.proxy ? "configured" : null,
    dataDir: config.dataDir,
    cos: {
      bucket: config.cos.bucket || null,
      region: config.cos.region || null,
      keyPrefix: config.cos.keyPrefix,
      authMode: "dynamic-sts",
    },
    instarStarSync: {
      enabled: instarStarSyncClient !== null,
      syncUrlConfigured: instarStarSyncUrl.length > 0,
    },
  });
}

if (import.meta.main) {
  await main();
}
