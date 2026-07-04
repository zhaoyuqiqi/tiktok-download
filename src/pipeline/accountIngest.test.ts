import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { PlatformAdapter, PlatformPostRef } from "../platforms/adapter.ts";
import type { ProcessStream } from "../types.ts";
import { initSchema, openDatabase } from "../storage/db.ts";
import { StateRepository } from "../storage/repository.ts";
import { computeNextRunAt, runAccountIngest } from "./accountIngest.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createRepo() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-account-ingest-"));
  tempDirs.push(dir);

  const db = openDatabase(join(dir, "state.db"));
  initSchema(db);
  return new StateRepository(db);
}

function createAdapter(listCalls: Array<{ limit?: number }>, total = 5): PlatformAdapter {
  return {
    platform: "tiktok",
    async listPosts(accountId, options) {
      listCalls.push({ limit: options?.limit });
      const refs: PlatformPostRef[] = [];
      for (let i = 0; i < total; i += 1) {
        const id = String(total - i);
        refs.push({
          platform: "tiktok",
          accountId,
          postId: `v-${id}`,
          url: `https://www.tiktok.com/@${accountId}/video/${id}`,
        });
      }
      if (typeof options?.limit === "number") {
        return refs.slice(0, options.limit);
      }
      return refs;
    },
    async fetchDetail(ref) {
      return {
        id: ref.postId,
        webpage_url: ref.url,
        timestamp: 1_720_000_000 + Number(ref.postId.replace("v-", "")),
      };
    },
    cleanse(detail, ref) {
      const data = detail as { id: string; webpage_url: string; timestamp: number };
      return {
        platform: "tiktok",
        accountId: ref.accountId,
        postId: data.id,
        sourceUrl: data.webpage_url,
        publishedAt: new Date(data.timestamp * 1000).toISOString(),
      };
    },
    async openMediaStream(): Promise<ProcessStream> {
      throw new Error("not used in this test");
    },
  };
}

describe("computeNextRunAt", () => {
  it("有新帖时使用最小间隔 30 分钟", () => {
    const next = computeNextRunAt({
      now: new Date("2026-07-03T10:00:00Z"),
      lastPostAt: "2026-07-03T09:59:00Z",
      newPostsCount: 1,
    });
    expect(next).toBe("2026-07-03T10:30:00.000Z");
  });

  it("24h 无新帖时降频到约 6 小时", () => {
    const next = computeNextRunAt({
      now: new Date("2026-07-03T10:00:00Z"),
      lastPostAt: "2026-07-02T09:00:00Z",
      newPostsCount: 0,
    });
    expect(next).toBe("2026-07-03T16:00:00.000Z");
  });
});

describe("runAccountIngest", () => {
  it("manual 模式仅拉最近 100 条并遵守去重", async () => {
    const repo = createRepo();
    const listCalls: Array<{ limit?: number }> = [];
    const adapter = createAdapter(listCalls, 120);

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@alice",
      nextRunAt: "2026-07-03T10:00:00Z",
      lastVideoId: null,
      active: true,
    });

    repo.markFetched({
      platform: "tiktok",
      postId: "v-100",
      status: "success",
      attempts: 1,
      fetchedAt: "2026-07-03T09:00:00Z",
    });

    const result = await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "manual",
      repo,
      adapter,
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    expect(listCalls).toEqual([{ limit: 100 }]);
    expect(result.listedCount).toBe(100);
    expect(result.dedupSkippedCount).toBe(1);
    expect(result.newCount).toBe(99);

    const account = repo.getAccount("tiktok", "@alice");
    expect(account?.lastVideoId).toBe("v-120");
    expect(account?.nextRunAt).toBe("2026-07-03T10:30:00.000Z");
  });

  it("manual 模式支持按请求 limit 抓取最新 N 条", async () => {
    const repo = createRepo();
    const listCalls: Array<{ limit?: number }> = [];
    const adapter = createAdapter(listCalls, 10);

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@alice",
      nextRunAt: "2026-07-03T10:00:00Z",
      lastVideoId: null,
      active: true,
    });

    const result = await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "manual",
      manualLimit: 3,
      repo,
      adapter,
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    expect(listCalls).toEqual([{ limit: 3 }]);
    expect(result.listedCount).toBe(3);
    expect(result.newCount).toBe(3);
  });

  it("due 模式无新帖且 24h 未更新时降频", async () => {
    const repo = createRepo();
    const listCalls: Array<{ limit?: number }> = [];
    const adapter = createAdapter(listCalls, 0);

    repo.upsertAccount({
      platform: "tiktok",
      accountId: "@bob",
      nextRunAt: "2026-07-03T10:00:00Z",
      lastPostAt: "2026-07-01T08:00:00Z",
      lastVideoId: "v-1",
      active: true,
    });

    const result = await runAccountIngest({
      platform: "tiktok",
      accountId: "@bob",
      source: "due",
      repo,
      adapter,
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    expect(listCalls).toEqual([{ limit: undefined }]);
    expect(result.newCount).toBe(0);
    expect(result.nextRunAt).toBe("2026-07-03T16:00:00.000Z");

    const account = repo.getAccount("tiktok", "@bob");
    expect(account?.nextRunAt).toBe("2026-07-03T16:00:00.000Z");
    expect(account?.lastVideoId).toBe("v-1");
  });

  it("适配器解耦: 可使用非 TikTok 的 PlatformAdapter 实现", async () => {
    const repo = createRepo();

    const adapter: PlatformAdapter = {
      platform: "mock-platform",
      async listPosts(accountId) {
        return [
          {
            platform: "mock-platform",
            accountId,
            postId: "m-1",
            url: `https://example.com/${accountId}/m-1`,
          },
        ];
      },
      async fetchDetail() {
        return { id: "m-1", when: "2026-07-03T10:00:00.000Z", link: "https://example.com/post/m-1" };
      },
      cleanse(detail, ref) {
        const data = detail as { id: string; when: string; link: string };
        return {
          platform: "mock-platform",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.link,
          publishedAt: data.when,
        };
      },
      async openMediaStream(): Promise<ProcessStream> {
        throw new Error("not used in this test");
      },
    };

    const result = await runAccountIngest({
      platform: "mock-platform",
      accountId: "acc-1",
      source: "due",
      repo,
      adapter,
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    expect(result.newCount).toBe(1);
    expect(result.dedupSkippedCount).toBe(0);

    const account = repo.getAccount("mock-platform", "acc-1");
    expect(account).not.toBeNull();
    expect(account?.lastVideoId).toBe("m-1");
    expect(repo.isFetched("mock-platform", "m-1")).toBeTrue();
  });

  it("新帖会直传 COS，并写入去重记录", async () => {
    const repo = createRepo();
    const cosKeys: string[] = [];

    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts(accountId) {
        return [
          {
            platform: "tiktok",
            accountId,
            postId: "v-1",
            url: `https://www.tiktok.com/@${accountId}/video/1`,
          },
        ];
      },
      async fetchDetail(ref) {
        return {
          id: ref.postId,
          webpage_url: ref.url,
          timestamp: 1_720_000_001,
        };
      },
      cleanse(detail, ref) {
        const data = detail as { id: string; webpage_url: string; timestamp: number };
        return {
          platform: "tiktok",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.webpage_url,
          publishedAt: new Date(data.timestamp * 1000).toISOString(),
        };
      },
      async openMediaStream(): Promise<ProcessStream> {
        return {
          stdout: Readable.from(["video-bytes"]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "due",
      repo,
      adapter,
      media: {
        bucket: "bucket-1",
        region: "ap-guangzhou",
        keyPrefix: "video",
        cosClient: {
          async putObject(input) {
            cosKeys.push(input.Key);
          },
        },

      },
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    expect(cosKeys).toHaveLength(1);
    expect(cosKeys[0]).toContain("video/tiktok");
    expect(repo.isFetched("tiktok", "v-1")).toBeTrue();
  });

  it("抓取过程会流式上传: 第一条完成后立即上传而不是等待全部详情完成", async () => {
    const repo = createRepo();
    const events: string[] = [];

    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts(accountId) {
        return [
          {
            platform: "tiktok",
            accountId,
            postId: "v-3",
            url: `https://www.tiktok.com/@${accountId}/video/3`,
          },
          {
            platform: "tiktok",
            accountId,
            postId: "v-2",
            url: `https://www.tiktok.com/@${accountId}/video/2`,
          },
          {
            platform: "tiktok",
            accountId,
            postId: "v-1",
            url: `https://www.tiktok.com/@${accountId}/video/1`,
          },
        ];
      },
      async fetchDetail(ref) {
        events.push(`fetch:${ref.postId}`);
        return {
          id: ref.postId,
          webpage_url: ref.url,
          timestamp: 1_720_000_000 + Number(ref.postId.replace("v-", "")),
        };
      },
      cleanse(detail, ref) {
        const data = detail as { id: string; webpage_url: string; timestamp: number };
        return {
          platform: "tiktok",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.webpage_url,
          publishedAt: new Date(data.timestamp * 1000).toISOString(),
        };
      },
      async openMediaStream(post): Promise<ProcessStream> {
        events.push(`open:${post.postId}`);
        return {
          stdout: Readable.from(["video-bytes"]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "due",
      repo,
      adapter,
      media: {
        bucket: "bucket-1",
        region: "ap-guangzhou",
        keyPrefix: "video",
        cosClient: {
          async putObject(input) {
            events.push(`put:${input.Key}`);
          },
        },
      },
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    const firstOpenIndex = events.findIndex((event) => event === "open:v-3");
    const secondFetchIndex = events.findIndex((event) => event === "fetch:v-2");

    expect(firstOpenIndex).toBeGreaterThanOrEqual(0);
    expect(secondFetchIndex).toBeGreaterThanOrEqual(0);
    expect(firstOpenIndex).toBeLessThan(secondFetchIndex);
  });

  it("新帖写入后会逐条触发 onPostSynced 回调", async () => {
    const repo = createRepo();
    const callbackPostIds: string[] = [];

    const adapter = createAdapter([], 3);

    await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "manual",
      manualLimit: 3,
      repo,
      adapter,
      now: () => new Date("2026-07-03T10:00:00Z"),
      onPostSynced: async (payload) => {
        callbackPostIds.push(payload.postId);
      },
    });

    expect(callbackPostIds).toEqual(["v-3", "v-2", "v-1"]);
  });

  it("帖子回调使用 COS object key（而不是公网 URL）", async () => {
    const repo = createRepo();
    let firstVideoUrl = "";
    let hasCosKeyField = false;

    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts(accountId) {
        return [
          {
            platform: "tiktok",
            accountId,
            postId: "v-1",
            url: `https://www.tiktok.com/@${accountId}/video/1`,
          },
        ];
      },
      async fetchDetail(ref) {
        return {
          id: ref.postId,
          webpage_url: ref.url,
          timestamp: 1_720_000_001,
          ext: "webm",
        };
      },
      cleanse(detail, ref) {
        const data = detail as { id: string; webpage_url: string; timestamp: number; ext: string };
        return {
          platform: "tiktok",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.webpage_url,
          publishedAt: new Date(data.timestamp * 1000).toISOString(),
          videoExt: data.ext,
          rawDetail: data,
        };
      },
      async openMediaStream(): Promise<ProcessStream> {
        return {
          stdout: Readable.from(["video-bytes"]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "manual",
      manualLimit: 1,
      repo,
      adapter,
      media: {
        bucket: "bucket-1",
        region: "ap-beijing",
        keyPrefix: "video",
        cosClient: {
          async putObject() {
            return;
          },
        },
      },
      now: () => new Date("2026-07-03T10:00:00Z"),
      onPostSynced: async (payload) => {
        firstVideoUrl = payload.videoUrl ?? "";
        hasCosKeyField = Object.prototype.hasOwnProperty.call(payload, "cosKey");
      },
    });

    expect(firstVideoUrl).toContain("video/tiktok/_alice/");
    expect(firstVideoUrl).toContain(".webm");
    expect(hasCosKeyField).toBeFalse();
  });

  it("图文贴不走视频流，使用缩略图上传 COS 并回调 image 资源", async () => {
    const repo = createRepo();
    const cosKeys: string[] = [];
    let openMediaCalled = false;
    let callbackMediaType = "";
    let callbackMediaUrl = "";

    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts(accountId) {
        return [
          {
            platform: "tiktok",
            accountId,
            postId: "img-1",
            url: `https://www.tiktok.com/@${accountId}/photo/img-1`,
          },
        ];
      },
      async fetchDetail(ref) {
        return {
          id: ref.postId,
          webpage_url: ref.url,
          timestamp: 1_720_000_001,
          video_ext: "none",
          thumbnail: "https://img.example.com/img-1.jpg",
        };
      },
      cleanse(detail, ref) {
        const data = detail as {
          id: string;
          webpage_url: string;
          timestamp: number;
          video_ext: string;
          thumbnail: string;
        };
        return {
          platform: "tiktok",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.webpage_url,
          publishedAt: new Date(data.timestamp * 1000).toISOString(),
          mediaType: data.video_ext === "none" ? "image" : "video",
          thumbnailUrl: data.thumbnail,
          rawDetail: data,
        };
      },
      async openMediaStream(): Promise<ProcessStream> {
        openMediaCalled = true;
        return {
          stdout: Readable.from(["video-bytes"]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    await runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "manual",
      manualLimit: 1,
      repo,
      adapter,
      media: {
        bucket: "bucket-1",
        region: "ap-beijing",
        keyPrefix: "video",
        fetchImpl: async () => new Response("image-bytes", { status: 200 }),
        cosClient: {
          async putObject(input) {
            cosKeys.push(input.Key);
          },
        },
      },
      now: () => new Date("2026-07-03T10:00:00Z"),
      onPostSynced: async (payload) => {
        callbackMediaType = payload.mediaType ?? "";
        callbackMediaUrl = payload.videoUrl ?? "";
      },
    });

    expect(openMediaCalled).toBeFalse();
    expect(cosKeys).toHaveLength(1);
    expect(cosKeys[0]).toContain("_image.jpg");
    expect(callbackMediaType).toBe("image");
    expect(callbackMediaUrl).toContain("video/tiktok/_alice/");
  });

  it("上传失败时不写入 fetched，错误向上抛出以触发调度退避", async () => {
    const repo = createRepo();

    const adapter: PlatformAdapter = {
      platform: "tiktok",
      async listPosts(accountId) {
        return [
          {
            platform: "tiktok",
            accountId,
            postId: "v-1",
            url: `https://www.tiktok.com/@${accountId}/video/1`,
          },
        ];
      },
      async fetchDetail(ref) {
        return {
          id: ref.postId,
          webpage_url: ref.url,
          timestamp: 1_720_000_001,
        };
      },
      cleanse(detail, ref) {
        const data = detail as { id: string; webpage_url: string; timestamp: number };
        return {
          platform: "tiktok",
          accountId: ref.accountId,
          postId: data.id,
          sourceUrl: data.webpage_url,
          publishedAt: new Date(data.timestamp * 1000).toISOString(),
        };
      },
      async openMediaStream(): Promise<ProcessStream> {
        return {
          stdout: Readable.from(["video-bytes"]),
          stderr: Readable.from([]),
          exited: Promise.resolve(0),
        };
      },
    };

    const ingestPromise = runAccountIngest({
      platform: "tiktok",
      accountId: "@alice",
      source: "due",
      repo,
      adapter,
      media: {
        bucket: "bucket-1",
        region: "ap-guangzhou",
        keyPrefix: "video",
        cosClient: {
          async putObject() {
            throw new Error("upload failed");
          },
        },
      },
      now: () => new Date("2026-07-03T10:00:00Z"),
    });

    await ingestPromise.then(
      () => {
        throw new Error("预期上传失败，但得到成功结果");
      },
      (error) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("upload failed");
      },
    );

    expect(repo.isFetched("tiktok", "v-1")).toBeFalse();
  });
});
