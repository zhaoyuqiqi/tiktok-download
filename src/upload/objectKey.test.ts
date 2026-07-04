import { describe, expect, it } from "bun:test";
import type { Post } from "../platforms/adapter.ts";
import { buildCosObjectKey } from "./objectKey.ts";

function post(partial?: Partial<Post>): Post {
  return {
    platform: "tiktok",
    accountId: "@alice",
    postId: "7657054518634351880",
    sourceUrl: "https://www.tiktok.com/@alice/video/7657054518634351880",
    ...partial,
  };
}

describe("buildCosObjectKey", () => {
  it("默认格式为 yyyyMMddHHmmss + 帖子 id", () => {
    const key = buildCosObjectKey(
      post({
        publishedAt: "2026-07-03T10:23:45.000Z",
      }),
    );

    expect(key).toBe("tiktok/_alice/20260703102345_7657054518634351880.mp4");
  });

  it("支持 prefix", () => {
    const key = buildCosObjectKey(
      post({ publishedAt: "2026-07-03T10:23:45.000Z" }),
      { prefix: "video" },
    );

    expect(key).toBe("video/tiktok/_alice/20260703102345_7657054518634351880.mp4");
  });

  it("缺少发布时间时使用兜底时间戳", () => {
    const key = buildCosObjectKey(post({ publishedAt: undefined }));
    expect(key).toContain("19700101000000_7657054518634351880.mp4");
  });

  it("优先使用详情中的扩展名 ext", () => {
    const key = buildCosObjectKey(post({ publishedAt: "2026-07-03T10:23:45.000Z", videoExt: "webm" }));
    expect(key).toBe("tiktok/_alice/20260703102345_7657054518634351880.webm");
  });

  it("支持 suffix 与 ext 覆盖", () => {
    const key = buildCosObjectKey(post({ publishedAt: "2026-07-03T10:23:45.000Z" }), {
      prefix: "video",
      suffix: "thumb",
      ext: "jpg",
    });
    expect(key).toBe("video/tiktok/_alice/20260703102345_7657054518634351880_thumb.jpg");
  });
});
