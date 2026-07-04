import { describe, expect, it } from "bun:test";
import { assertRequiredWebhookEnv } from "./index.ts";

describe("assertRequiredWebhookEnv", () => {
  it("缺失 APP_INSTAR_POST_WEBHOOK_URL 时抛错", () => {
    expect(() =>
      assertRequiredWebhookEnv({
        APP_INSTAR_WEBHOOK_URL: "https://example.com/account-complete",
      }),
    ).toThrow("APP_INSTAR_POST_WEBHOOK_URL");
  });

  it("存在 APP_INSTAR_POST_WEBHOOK_URL 时返回去空格后的值", () => {
    const result = assertRequiredWebhookEnv({
      APP_INSTAR_POST_WEBHOOK_URL: "  https://example.com/post-synced  ",
    });

    expect(result.postWebhookUrl).toBe("https://example.com/post-synced");
    expect(result.accountWebhookUrl).toBe("");
  });

  it("支持配置帖子回调 Bearer", () => {
    const result = assertRequiredWebhookEnv({
      APP_INSTAR_POST_WEBHOOK_URL: "https://example.com/post-synced",
      APP_INSTAR_POST_WEBHOOK_AUTH_BEARER: "  token-a  ",
    });

    expect(result.postWebhookBearer).toBe("token-a");
  });
});
