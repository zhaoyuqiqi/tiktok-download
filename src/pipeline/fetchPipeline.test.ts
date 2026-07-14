import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import type { PlatformAdapter, PlatformPostRef, Post } from "../platforms/adapter.ts";
import { collectNewPosts, sortPostsByPublishedAt } from "./fetchPipeline.ts";

function fakeRef(id: string): PlatformPostRef {
  return {
    platform: "tiktok",
    accountId: "@alice",
    postId: id,
    url: `https://www.tiktok.com/@alice/video/${id}`,
  };
}

function fakePost(id: string, publishedAt?: string): Post {
  return {
    platform: "tiktok",
    accountId: "@alice",
    postId: id,
    sourceUrl: `https://www.tiktok.com/@alice/video/${id}`,
    publishedAt,
  };
}

describe("fetchPipeline", () => {
  it("collectNewPosts: 过滤 lastVideoId 之前的帖子并按发布时间升序返回", async () => {
    const refs = [fakeRef("v5"), fakeRef("v4"), fakeRef("v3"), fakeRef("v2")];
    const detailMap = new Map<string, Post>([
      ["v5", fakePost("v5", "2026-07-03T10:03:00.000Z")],
      ["v4", fakePost("v4", "2026-07-03T10:02:00.000Z")],
      ["v3", fakePost("v3", "2026-07-03T10:01:00.000Z")],
    ]);

    const calledIds: string[] = [];
    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts() {
        return refs;
      },
      async fetchDetail(ref) {
        calledIds.push(ref.postId);
        return detailMap.get(ref.postId) ?? {};
      },
      cleanse(detail) {
        return detail as Post;
      },
      async openMediaStream() {
        return {
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    const posts = await collectNewPosts(adapter, {
      accountId: "@alice",
      lastVideoId: "v3",
    });

    expect(calledIds).toEqual(["v4", "v5"]);
    expect(posts.map((p) => p.postId)).toEqual(["v4", "v5"]);
  });

  it("collectNewPosts: 未提供 lastVideoId 时抓取全部", async () => {
    const refs = [fakeRef("v2"), fakeRef("v1")];
    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts() {
        return refs;
      },
      async fetchDetail(ref) {
        return fakePost(ref.postId, `2026-07-03T10:0${ref.postId === "v2" ? "2" : "1"}:00.000Z`);
      },
      cleanse(detail) {
        return detail as Post;
      },
      async openMediaStream() {
        return {
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    const posts = await collectNewPosts(adapter, { accountId: "@alice" });
    expect(posts.map((p) => p.postId)).toEqual(["v1", "v2"]);
  });

  it("sortPostsByPublishedAt: 对标准化 Post 结构按发布时间从旧到新排序", () => {
    const result = sortPostsByPublishedAt([
      fakePost("v3", "2026-07-03T10:03:00.000Z"),
      fakePost("v1", "2026-07-03T10:01:00.000Z"),
      fakePost("v2", "2026-07-03T10:02:00.000Z"),
    ]);

    expect(result.map((p) => p.postId)).toEqual(["v1", "v2", "v3"]);
  });
});
