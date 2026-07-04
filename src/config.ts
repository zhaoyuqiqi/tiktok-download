export interface CosConfig {
  bucket: string;
  region: string;
  secretId: string;
  secretKey: string;
  keyPrefix: string;
}

export interface ServiceConfig {
  fetchIntervalSeconds: number;
  accountReconcileIntervalSeconds: number;
  globalConcurrency: number;
  proxy?: string;
  dataDir: string;
  cos: CosConfig;
}

const DEFAULTS = {
  fetchIntervalSeconds: 300,
  accountReconcileIntervalSeconds: 300,
  globalConcurrency: 2,
  dataDir: "./data",
  cosKeyPrefix: "tiktok",
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
    proxy: str("APP_PROXY_URL", env.APP_PROXY_URL) || undefined,
    dataDir: str("APP_DATA_DIR", env.APP_DATA_DIR, DEFAULTS.dataDir),
    cos: {
      bucket: str("COS_BUCKET", env.COS_BUCKET),
      region: str("COS_REGION", env.COS_REGION),
      secretId: str("COS_SECRET_ID", env.COS_SECRET_ID),
      secretKey: str("COS_SECRET_KEY", env.COS_SECRET_KEY),
      keyPrefix: str("COS_KEY_PREFIX", env.COS_KEY_PREFIX, DEFAULTS.cosKeyPrefix),
    },
  };
}
