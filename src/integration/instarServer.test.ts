import { describe, expect, it } from "bun:test";
import {
  HttpInstarPostSyncClient,
  HttpInstarServerClient,
  NoopInstarServerClient,
  toInstarAccountCompletedPayload,
  toInstarPostSyncedPayload,
} from "./instarServer.ts";

describe("instarServer adapter layer", () => {
  it("toInstarAccountCompletedPayload: 映射账号级完成回调结构", () => {
    expect(toInstarAccountCompletedPayload("@alice", 1)).toEqual({
      starId: "@alice",
      token: "instar",
      status: 1,
    });
    expect(toInstarAccountCompletedPayload("@alice", 0).status).toBe(0);
  });

  it("HttpInstarServerClient: 请求成功时发送固定 payload", async () => {
    let gotUrl = "";
    let gotMethod = "";
    let gotAuth = "";
    let gotBody = "";

    const client = new HttpInstarServerClient({
      url: "https://example.com/webhook",
      bearerToken: "token-1",
      fetchImpl: async (url, init) => {
        gotUrl = String(url);
        gotMethod = init?.method ?? "";
        gotAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        gotBody = String(init?.body ?? "");
        return new Response("ok", { status: 200 });
      },
    });

    await client.notifyAccountCompleted({
      starId: "@alice",
      token: "instar",
      status: 1,
    });

    expect(gotUrl).toBe("https://example.com/webhook");
    expect(gotMethod).toBe("POST");
    expect(gotAuth).toBe("Bearer token-1");
    expect(JSON.parse(gotBody)).toEqual({
      starId: "@alice",
      token: "instar",
      status: 1,
    });
  });

  it("HttpInstarServerClient: 非 2xx 时抛错", async () => {
    const client = new HttpInstarServerClient({
      url: "https://example.com/webhook",
      fetchImpl: async () => new Response("fail", { status: 500, statusText: "Internal Error" }),
    });

    await expect(
      client.notifyAccountCompleted({
        starId: "@alice",
        token: "instar",
        status: 0,
      }),
    ).rejects.toThrow("instar 回调失败");
  });

  it("toInstarPostSyncedPayload: tiktok 必须映射为 Post 契约", () => {
    expect(
      toInstarPostSyncedPayload({
        platform: "tiktok",
        starId: "@alice",
        postId: "v-1",
        sourceUrl: "https://www.tiktok.com/@alice/video/1",
        videoUrl: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1.mp4",
        thumbnailUrl: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1_thumb.jpg",
        publishedAt: "2026-07-04T10:00:00.000Z",
        title: "A title",
        rawDetail: {
          uploader: "alice",
          uploader_id: "uid-1001",
          channel: "Alice Name",
          thumbnail: "https://img.example.com/cover.jpg",
          width: 1080,
          height: 1920,
        },
      }),
    ).toEqual({
      insPostId: "v-1",
      starName: "alice",
      fullName: "Alice Name",
      title: "A title",
      isTop: false,
      insStarId: "uid-1001",
      publishTime: 1_783_159_200,
      resources: [
        {
          type: "video",
          url: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1.mp4",
          thumbnail_url: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1_thumb.jpg",
          width: 1080,
          height: 1920,
        },
      ],
    });
  });

  it("toInstarPostSyncedPayload: 不支持的平台应抛错", () => {
    expect(() =>
      toInstarPostSyncedPayload({
        platform: "unsupported",
        starId: "@alice",
        postId: "v-1",
        sourceUrl: "https://example.com/v-1",
      }),
    ).toThrow("未找到平台帖子格式化器");
  });

  it("HttpInstarPostSyncClient: 请求成功时发送 Post 契约", async () => {
    let gotUrl = "";
    let gotAuth = "";
    let gotBody = "";

    const client = new HttpInstarPostSyncClient({
      url: "https://example.com/post-webhook",
      bearerToken: "token-2",
      fetchImpl: async (url, init) => {
        gotUrl = String(url);
        gotAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        gotBody = String(init?.body ?? "");
        return new Response("ok", { status: 200 });
      },
    });

    await client.notifyPostSynced({
      insPostId: "v-1",
      starName: "alice",
      fullName: "Alice Name",
      title: "A title",
      isTop: false,
      insStarId: "@alice",
      publishTime: 1_751_624_400,
      resources: [
        {
          type: "video",
          url: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1.mp4",
        },
      ],
    });

    expect(gotUrl).toBe("https://example.com/post-webhook");
    expect(gotAuth).toBe("Bearer token-2");
    expect(JSON.parse(gotBody)).toEqual({
      insPostId: "v-1",
      starName: "alice",
      fullName: "Alice Name",
      title: "A title",
      isTop: false,
      insStarId: "@alice",
      publishTime: 1_751_624_400,
      resources: [
        {
          type: "video",
          url: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1.mp4",
        },
      ],
    });
  });

  it("HttpInstarPostSyncClient: 非 2xx 时抛错", async () => {
    const client = new HttpInstarPostSyncClient({
      url: "https://example.com/post-webhook",
      fetchImpl: async () => new Response("fail", { status: 500, statusText: "Internal Error" }),
    });

    await expect(
      client.notifyPostSynced({
        insPostId: "v-1",
        starName: "alice",
        fullName: "Alice Name",
        title: "A title",
        isTop: false,
        insStarId: "@alice",
        publishTime: 1_751_624_400,
        resources: [
          {
            type: "video",
            url: "https://bucket.cos.ap-beijing.myqcloud.com/tiktok/a/v-1.mp4",
          },
        ],
      }),
    ).rejects.toThrow("instar 帖子回调失败");
  });

  it("NoopInstarServerClient: 默认不抛错", async () => {
    const client = new NoopInstarServerClient();
    await expect(
      client.notifyAccountCompleted({
        starId: "@alice",
        token: "instar",
        status: 1,
      }),
    ).resolves.toBeUndefined();
  });
});
