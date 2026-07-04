import { describe, expect, it } from "bun:test";
import { loadServiceConfig } from "./config.ts";

describe("loadServiceConfig", () => {
  it("使用默认值", () => {
    const cfg = loadServiceConfig({});

    expect(cfg.fetchIntervalSeconds).toBe(300);
    expect(cfg.globalConcurrency).toBe(2);
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.proxy).toBeUndefined();
    expect(cfg.cos.keyPrefix).toBe("tiktok");
  });

  it("支持通过环境变量覆盖", () => {
    const cfg = loadServiceConfig({
      APP_FETCH_INTERVAL_SECONDS: "600",
      APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS: "120",
      APP_GLOBAL_CONCURRENCY: "4",
      APP_PROXY_URL: "http://127.0.0.1:7890",
      APP_DATA_DIR: "/var/lib/tiktok",
      COS_BUCKET: "demo-1250000000",
      COS_REGION: "ap-guangzhou",
      COS_SECRET_ID: "id",
      COS_SECRET_KEY: "key",
      COS_KEY_PREFIX: "video",
    });

    expect(cfg.fetchIntervalSeconds).toBe(600);
    expect(cfg.globalConcurrency).toBe(4);
    expect(cfg.proxy).toBe("http://127.0.0.1:7890");
    expect(cfg.dataDir).toBe("/var/lib/tiktok");
    expect(cfg.cos.bucket).toBe("demo-1250000000");
    expect(cfg.cos.region).toBe("ap-guangzhou");
    expect(cfg.cos.secretId).toBe("id");
    expect(cfg.cos.secretKey).toBe("key");
    expect(cfg.cos.keyPrefix).toBe("video");
  });

  it("非法数值会抛错", () => {
    expect(() => loadServiceConfig({ APP_GLOBAL_CONCURRENCY: "0" })).toThrow(
      "APP_GLOBAL_CONCURRENCY 必须是正整数",
    );
    expect(() => loadServiceConfig({ APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS: "-1" })).toThrow(
      "APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS 必须是正整数",
    );
    expect(() => loadServiceConfig({ APP_FETCH_INTERVAL_SECONDS: "abc" })).toThrow(
      "APP_FETCH_INTERVAL_SECONDS 必须是正整数",
    );
  });
});
