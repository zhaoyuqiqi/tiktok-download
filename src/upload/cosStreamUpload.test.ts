import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import type { PlatformAdapter, PlatformPostRef, Post } from "../platforms/adapter.ts";
import { uploadPostStreamToCos } from "./cosStreamUpload.ts";

const post: Post = {
  platform: "tiktok",
  accountId: "@alice",
  postId: "v1",
  sourceUrl: "https://www.tiktok.com/@alice/video/v1",
};

function createAdapter(exitCode: number): PlatformAdapter {
  return {
    platform: "tiktok",
    async listPosts(): Promise<PlatformPostRef[]> {
      return [];
    },
    async fetchDetail(): Promise<unknown> {
      return {};
    },
    cleanse(): Post {
      return post;
    },
    async openMediaStream() {
      return {
        stdout: Readable.from(["video-bytes"]),
        stderr: Readable.from([]),
        exited: Promise.resolve(exitCode),
      };
    },
  };
}

describe("uploadPostStreamToCos", () => {
  it("直接将媒体流上传 COS（不落地磁盘）", async () => {
    const calls: Array<{ Bucket: string; Region: string; Key: string; hasBody: boolean }> = [];

    const cos = {
      async putObject(input: { Bucket: string; Region: string; Key: string; Body: NodeJS.ReadableStream }) {
        calls.push({
          Bucket: input.Bucket,
          Region: input.Region,
          Key: input.Key,
          hasBody: typeof (input.Body as Readable).pipe === "function",
        });
        return { etag: "ok" };
      },
    };

    await uploadPostStreamToCos({
      adapter: createAdapter(0),
      post,
      cosClient: cos,
      bucket: "bucket-1",
      region: "ap-guangzhou",
      key: "video/tiktok/alice/v1.mp4",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      Bucket: "bucket-1",
      Region: "ap-guangzhou",
      Key: "video/tiktok/alice/v1.mp4",
      hasBody: true,
    });
  });

  it("媒体流进程非 0 退出时抛错", async () => {
    const cos = {
      async putObject() {
        return { etag: "ok" };
      },
    };

    await expect(
      uploadPostStreamToCos({
        adapter: createAdapter(2),
        post,
        cosClient: cos,
        bucket: "bucket-1",
        region: "ap-guangzhou",
        key: "video/tiktok/alice/v1.mp4",
      }),
    ).rejects.toThrow("媒体流读取失败");
  });
});
