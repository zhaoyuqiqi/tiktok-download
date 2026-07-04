import { describe, expect, it } from "bun:test";
import type { Post } from "../platforms/adapter.ts";
import { NoopInstarServerClient, toInstarServerPayload } from "./instarServer.ts";

describe("instarServer adapter layer", () => {
  it("toInstarServerPayload: 将标准化 Post 映射为 instar-server 回传结构", () => {
    const post: Post = {
      platform: "tiktok",
      accountId: "@alice",
      postId: "v1",
      sourceUrl: "https://www.tiktok.com/@alice/video/v1",
      title: "title",
      description: "desc",
      publishedAt: "2026-07-03T10:00:00.000Z",
    };

    const payload = toInstarServerPayload(post, {
      objectKey: "video/tiktok/_alice/20260703100000_v1.mp4",
      bucket: "bucket-1",
      region: "ap-guangzhou",
    });

    expect(payload.platform).toBe("tiktok");
    expect(payload.accountId).toBe("@alice");
    expect(payload.postId).toBe("v1");
    expect(payload.media.objectKey).toContain("v1.mp4");
  });

  it("NoopInstarServerClient: 预留实现默认不抛错", async () => {
    const client = new NoopInstarServerClient();
    await expect(
      client.notifyPostIngested({
        platform: "tiktok",
        accountId: "@alice",
        postId: "v1",
        media: {
          objectKey: "x.mp4",
          bucket: "bucket-1",
          region: "ap-guangzhou",
        },
      }),
    ).resolves.toBeUndefined();
  });
});
