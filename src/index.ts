import { join } from "node:path";
import COS from "cos-nodejs-sdk-v5";
import { loadServiceConfig } from "./config.ts";
import { AccountSourceClient } from "./integration/accountSourceClient.ts";
import { NoopInstarServerClient } from "./integration/instarServer.ts";
import { debugLog, isDebugEnabled } from "./logging/debugLogger.ts";
import { runAccountIngest, type MediaPipelineOptions } from "./pipeline/accountIngest.ts";
import { TikTokAdapter } from "./platforms/tiktokAdapter.ts";
import { reconcileAccounts } from "./scheduling/accountReconciler.ts";
import { DueScheduler } from "./scheduling/dueScheduler.ts";
import { createApp } from "./server.ts";
import { initSchema, openDatabase } from "./storage/db.ts";
import { StateRepository } from "./storage/repository.ts";
import type { CosPutObjectInput } from "./upload/cosStreamUpload.ts";
import { YtDlpRunner } from "./ytdlp-manager/runner.ts";
import { YtDlpService } from "./ytdlp-manager/ytDlpService.ts";

interface RawCosClient {
  putObject(
    input: CosPutObjectInput,
    callback: (error: unknown, data: unknown) => void,
  ): void;
}

function createCosClient(config: {
  secretId: string;
  secretKey: string;
}): RawCosClient {
  return new COS({
    SecretId: config.secretId,
    SecretKey: config.secretKey,
  }) as unknown as RawCosClient;
}

function createTraceId(accountId: string, source: "due" | "manual"): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}-${source}-${accountId}-${rand}`;
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 3000);
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

  const cosConfigured =
    config.cos.bucket.length > 0 &&
    config.cos.region.length > 0 &&
    config.cos.secretId.length > 0 &&
    config.cos.secretKey.length > 0;

  if (!cosConfigured) {
    throw new Error("COS 配置不完整：请至少配置 COS_BUCKET/COS_REGION/COS_SECRET_ID/COS_SECRET_KEY");
  }

  const rawCosClient = createCosClient({
    secretId: config.cos.secretId,
    secretKey: config.cos.secretKey,
  });

  const mediaPipeline: MediaPipelineOptions = {
    cosClient: {
      async putObject(input: CosPutObjectInput): Promise<unknown> {
        return await new Promise((resolve, reject) => {
          rawCosClient.putObject(input, (error, data) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(data);
          });
        });
      },
    },
    bucket: config.cos.bucket,
    region: config.cos.region,
    keyPrefix: config.cos.keyPrefix,
    instarClient: new NoopInstarServerClient(),
  };

  const dueScheduler = new DueScheduler({
    concurrency: config.globalConcurrency,
    async listDueAccounts(limit) {
      return repo.listDueAccounts({
        platform,
        nowIso: new Date().toISOString(),
        limit,
      });
    },
    async runAccount(accountId, source) {
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
          traceId,
        });

        debugLog("run_account.done", {
          traceId,
          platform,
          accountId,
          source,
          result,
        });
      } catch (error) {
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
      credentialsConfigured: Boolean(config.cos.secretId && config.cos.secretKey),
    },
  });
}

if (import.meta.main) {
  await main();
}
