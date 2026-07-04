import { describe, expect, it } from "bun:test";
import { Readable } from "node:stream";
import type { ProcessResult, ProcessRunner } from "../types.ts";
import { TikTokAdapter } from "./tiktokAdapter.ts";

function createRunner(options: {
  result?: ProcessResult;
  runCalls?: string[][];
  streamCalls?: string[][];
}): ProcessRunner {
  return {
    async run(args: string[]) {
      options.runCalls?.push(args);
      return options.result ?? { code: 0, stdout: "{}", stderr: "" };
    },
    runStream(args: string[]) {
      options.streamCalls?.push(args);
      return {
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        exited: Promise.resolve(0),
      };
    },
  };
}

describe("TikTokAdapter", () => {
  it("listPosts 使用 -J --flat-playlist 并返回帖子引用", async () => {
    const runCalls: string[][] = [];
    const adapter = new TikTokAdapter(
      createRunner({
        runCalls,
        result: {
          code: 0,
          stdout: JSON.stringify({
            entries: [
              { id: "v1", url: "https://www.tiktok.com/@alice/video/v1", title: "Video 1" },
              { id: "v2", webpage_url: "https://www.tiktok.com/@alice/video/v2", title: "Video 2" },
            ],
          }),
          stderr: "",
        },
      }),
      { requestDelayRangeMs: [0, 0] },
    );

    const refs = await adapter.listPosts("@alice", { limit: 5, proxy: "http://127.0.0.1:7890" });

    expect(refs).toHaveLength(2);
    expect(refs[0]?.postId).toBe("v1");
    expect(refs[1]?.url).toBe("https://www.tiktok.com/@alice/video/v2");
    expect(runCalls[0]).toEqual([
      "-J",
      "--flat-playlist",
      "-I",
      ":5",
      "--proxy",
      "http://127.0.0.1:7890",
      "https://www.tiktok.com/@alice",
    ]);
  });

  it("fetchDetail 透传 -J 并返回 JSON", async () => {
    const runCalls: string[][] = [];
    const adapter = new TikTokAdapter(
      createRunner({
        runCalls,
        result: {
          code: 0,
          stdout: JSON.stringify({
            id: "v1",
            title: "Detail Title",
            description: "desc",
            uploader_id: "alice",
            timestamp: 1735689600,
          }),
          stderr: "",
        },
      }),
      { requestDelayRangeMs: [0, 0] },
    );

    const detail = await adapter.fetchDetail(
      {
        platform: "tiktok",
        accountId: "@alice",
        postId: "v1",
        url: "https://www.tiktok.com/@alice/video/v1",
      },
      { proxy: "http://127.0.0.1:7890" },
    );

    expect((detail as { id: string }).id).toBe("v1");
    expect(runCalls[0]).toEqual([
      "-J",
      "--proxy",
      "http://127.0.0.1:7890",
      "https://www.tiktok.com/@alice/video/v1",
    ]);
  });

  it("每次 yt-dlp 调用前都会执行随机延迟", async () => {
    const sleeps: number[] = [];
    const runCalls: string[][] = [];
    const streamCalls: string[][] = [];
    const adapter = new TikTokAdapter(
      createRunner({ runCalls, streamCalls, result: { code: 0, stdout: "{}", stderr: "" } }),
      {
        requestDelayRangeMs: [2, 8],
        random: () => 0,
        async sleep(ms) {
          sleeps.push(ms);
        },
      },
    );

    await adapter.listPosts("@alice");
    await adapter.fetchDetail({
      platform: "tiktok",
      accountId: "@alice",
      postId: "v1",
      url: "https://www.tiktok.com/@alice/video/v1",
    });
    await adapter.openMediaStream({
      platform: "tiktok",
      accountId: "@alice",
      postId: "v1",
      sourceUrl: "https://www.tiktok.com/@alice/video/v1",
    });

    expect(sleeps).toEqual([2, 2, 2]);
    expect(runCalls).toHaveLength(2);
    expect(streamCalls).toHaveLength(1);
  });

  it("cleanse 输出标准化 Post", () => {
    const adapter = new TikTokAdapter(createRunner({}), { requestDelayRangeMs: [0, 0] });
    const post = adapter.cleanse(
      {
        id: "v1",
        title: "Video 1",
        description: "desc",
        uploader_id: "alice",
        timestamp: 1735689600,
        webpage_url: "https://www.tiktok.com/@alice/video/v1",
      },
      {
        platform: "tiktok",
        accountId: "@alice",
        postId: "v1",
        url: "https://www.tiktok.com/@alice/video/v1",
      },
    );

    expect(post.platform).toBe("tiktok");
    expect(post.accountId).toBe("@alice");
    expect(post.postId).toBe("v1");
    expect(post.sourceUrl).toBe("https://www.tiktok.com/@alice/video/v1");
    expect(post.authorHandle).toBe("alice");
    expect(post.publishedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("openMediaStream 使用 -o - 打开媒体流", async () => {
    const streamCalls: string[][] = [];
    const adapter = new TikTokAdapter(createRunner({ streamCalls }), { requestDelayRangeMs: [0, 0] });

    const stream = await adapter.openMediaStream(
      {
        platform: "tiktok",
        accountId: "@alice",
        postId: "v1",
        sourceUrl: "https://www.tiktok.com/@alice/video/v1",
      },
      { proxy: "http://127.0.0.1:7890" },
    );

    expect(stream).toBeDefined();
    expect(streamCalls[0]).toEqual([
      "--no-playlist",
      "-o",
      "-",
      "--proxy",
      "http://127.0.0.1:7890",
      "https://www.tiktok.com/@alice/video/v1",
    ]);
  });
});
