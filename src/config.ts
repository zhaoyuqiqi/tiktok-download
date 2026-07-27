export interface CosConfig {
  bucket: string;
  region: string;
  keyPrefix: string;
}

export type WorkerMode = "local" | "github-actions";

export interface ServiceConfig {
  fetchIntervalSeconds: number;
  accountReconcileIntervalSeconds: number;
  globalConcurrency: number;
  workerMode: WorkerMode;
  workerLeaseSeconds: number;
  workerApiToken?: string;
  proxy?: string;
  dataDir: string;
  cos: CosConfig;
  cookiePath?: string;
}

const DEFAULTS = {
  fetchIntervalSeconds: 300,
  accountReconcileIntervalSeconds: 300,
  globalConcurrency: 2,
  workerMode: "local" as WorkerMode,
  workerLeaseSeconds: 300,
  dataDir: "./data",
  cosKeyPrefix: "tiktok-download",
} as const;

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是正整数，收到: ${raw}`);
  }

  return value;
}

function str(_name: string, raw: string | undefined, fallback = ""): string {
  if (raw === undefined) {
    return fallback;
  }

  const value = raw.trim();
  if (value.length === 0) {
    return fallback;
  }

  return value;
}

function workerMode(raw: string | undefined): WorkerMode {
  const value = str("APP_WORKER_MODE", raw, DEFAULTS.workerMode);
  if (value !== "local" && value !== "github-actions") {
    throw new Error(
      `APP_WORKER_MODE 必须是 local 或 github-actions，收到: ${value}`,
    );
  }
  return value;
}

export function loadServiceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  return {
    fetchIntervalSeconds: positiveInt(
      "APP_FETCH_INTERVAL_SECONDS",
      env.APP_FETCH_INTERVAL_SECONDS,
      DEFAULTS.fetchIntervalSeconds,
    ),
    accountReconcileIntervalSeconds: positiveInt(
      "APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS",
      env.APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS,
      DEFAULTS.accountReconcileIntervalSeconds,
    ),
    globalConcurrency: positiveInt(
      "APP_GLOBAL_CONCURRENCY",
      env.APP_GLOBAL_CONCURRENCY,
      DEFAULTS.globalConcurrency,
    ),
    workerMode: workerMode(env.APP_WORKER_MODE),
    workerLeaseSeconds: positiveInt(
      "APP_WORKER_LEASE_SECONDS",
      env.APP_WORKER_LEASE_SECONDS,
      DEFAULTS.workerLeaseSeconds,
    ),
    workerApiToken: str("APP_WORKER_API_TOKEN", env.APP_WORKER_API_TOKEN) || undefined,
    proxy: str("APP_PROXY_URL", env.APP_PROXY_URL) || undefined,
    dataDir: str("APP_DATA_DIR", env.APP_DATA_DIR, DEFAULTS.dataDir),
    cos: {
      bucket: str("COS_BUCKET", env.COS_BUCKET),
      region: str("COS_REGION", env.COS_REGION),
      keyPrefix: str("COS_KEY_PREFIX", env.COS_KEY_PREFIX, DEFAULTS.cosKeyPrefix),
    },
    cookiePath: str("COOKIE_PATH", env.COOKIE_PATH) || undefined,
  };
}
