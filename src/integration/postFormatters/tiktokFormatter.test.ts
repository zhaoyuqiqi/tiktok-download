import { describe, expect, it } from "bun:test";
import { formatTikTokPost } from "./tiktokFormatter.ts";

describe("formatTikTokPost", () => {
  it("按最外层字段映射为 Post 契约", () => {
    const post = formatTikTokPost({
      platform: "tiktok",
      starId: "@yua_mikami",
      postId: "7658595177044446482",
      sourceUrl: "https://www.tiktok.com/@yua_mikami/video/7658595177044446482",
      videoUrl: "https://bucket-1.cos.ap-beijing.myqcloud.com/video/tiktok/yua/7658595177044446482.mp4",
      thumbnailUrl: "https://bucket-1.cos.ap-beijing.myqcloud.com/video/tiktok/yua/7658595177044446482_thumb.jpg",
      rawDetail: {
        id: "7658595177044446482",
        channel: "三上悠亜",
        channel_id: "MS4wLjABAAAA-Rq0N86HaTzt6fKHErvshWxG5mDfLr4hqaQZmnbU7aBRsa59im9welgCBGOmn6pV",
        uploader: "yua_mikami",
        uploader_id: "6557999606692954114",
        title: "TikTok video #7658595177044446482",
        timestamp: 1783155654,
        thumbnail: "https://p16-common-sign.tiktokcdn-eu.com/cover.jpg",
        width: 1080,
        height: 1920,
        url: "https://v19-webapp-prime.tiktok.com/original.mp4",
      },
    });

    expect(post).toEqual({
      insPostId: "7658595177044446482",
      starName: "yua_mikami",
      fullName: "三上悠亜",
      title: "TikTok video #7658595177044446482",
      isTop: false,
      insStarId: "6557999606692954114",
      publishTime: 1783155654,
      resources: [
        {
          type: "video",
          url: "https://bucket-1.cos.ap-beijing.myqcloud.com/video/tiktok/yua/7658595177044446482.mp4",
          thumbnail_url: "https://bucket-1.cos.ap-beijing.myqcloud.com/video/tiktok/yua/7658595177044446482_thumb.jpg",
          width: 1080,
          height: 1920,
        },
      ],
    });
  });

  it("无 uploader_id 时回退 channel_id，再回退 starId", () => {
    const post = formatTikTokPost({
      platform: "tiktok",
      starId: "@fallback",
      postId: "v-1",
      sourceUrl: "https://www.tiktok.com/@fallback/video/v-1",
      rawDetail: {
        channel_id: "channel-1",
      },
    });

    expect(post.insStarId).toBe("channel-1");
    expect(post.starName).toBe("fallback");
  });

  it("图文贴输出 image 资源", () => {
    const post = formatTikTokPost({
      platform: "tiktok",
      starId: "@alice",
      postId: "img-1",
      sourceUrl: "https://www.tiktok.com/@alice/photo/img-1",
      mediaType: "image",
      videoUrl: "https://bucket.cos.ap-beijing.myqcloud.com/video/tiktok/_alice/img-1_image.jpg",
      thumbnailUrl: "https://bucket.cos.ap-beijing.myqcloud.com/video/tiktok/_alice/img-1_image.jpg",
      rawDetail: {
        uploader: "alice",
        uploader_id: "uid-a",
      },
    });

    expect(post.resources).toEqual([
      {
        type: "image",
        url: "https://bucket.cos.ap-beijing.myqcloud.com/video/tiktok/_alice/img-1_image.jpg",
        width: undefined,
        height: undefined,
      },
    ]);
  });

  it("不再做 COS 域名判断，透传输入资源地址", () => {
    const post = formatTikTokPost({
      platform: "tiktok",
      starId: "@alice",
      postId: "v-raw",
      sourceUrl: "https://www.tiktok.com/@alice/video/v-raw",
      videoUrl: "https://www.tiktok.com/@alice/video/v-raw",
      thumbnailUrl: "https://p16-sign-va.tiktokcdn.com/cover.jpg",
      rawDetail: {
        uploader: "alice",
        uploader_id: "uid-a",
        url: "https://v16.tiktokcdn.com/raw.mp4",
        thumbnail: "https://p16-sign-va.tiktokcdn.com/raw-cover.jpg",
      },
    });

    expect(post.resources).toEqual([
      {
        type: "video",
        url: "https://www.tiktok.com/@alice/video/v-raw",
        thumbnail_url: "https://p16-sign-va.tiktokcdn.com/cover.jpg",
        width: undefined,
        height: undefined,
      },
    ]);
  });
});
