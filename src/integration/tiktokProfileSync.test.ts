import { describe, expect, it } from "bun:test";
import type { ProcessRunner } from "../types.ts";
import type { CosPutObjectInput } from "../upload/cosStreamUpload.ts";
import { fetchTikTokProfilePayload, syncTikTokProfileBeforeFetch } from "./tiktokProfileSync.ts";
import type { CosUploader } from "../upload/uploader.ts";

function makeRunner(result: { code: number; stdout: string; stderr: string }, onArgs?: (args: string[]) => void): ProcessRunner {
  return {
    async run(args: string[]) {
      onArgs?.(args);
      return result;
    },
    async generateRun() {
      throw new Error("not implemented");
    },
    runStream() {
      throw new Error("not implemented");
    },
  };
}

describe("fetchTikTokProfilePayload", () => {
  it("通过 patch-yt-dlp JSON 输出提取资料并映射为 instar 同步结构", async () => {
    const result = await fetchTikTokProfilePayload({
      accountId: "@yua_mikami",
      proxy: "http://127.0.0.1:2080",
      runner: makeRunner(
        {
          code: 0,
          stdout: JSON.stringify({
            uploader_id: "6557999606692954114",
            uploader: "yua_mikami",
            channel: "三上悠亜",
            avatar_larger: "https://img.example.com/a.jpg",
            aweme_count: 1509,
            channel_follower_count: 4850008,
            following_count: 73,
          }),
          stderr: "",
        },
        (args) => {
          expect(args).toEqual([
            "--proxy",
            "http://127.0.0.1:2080",
            "--flat-playlist",
            "--playlist-items",
            "0",
            "-J",
            "--sleep-requests",
            "1",
            "--no-warnings",
            "https://www.tiktok.com/@yua_mikami",
          ]);
        },
      ),
    });

    expect(result).toEqual({
      insStarId: "6557999606692954114",
      starName: "yua_mikami",
      fullName: "三上悠亜",
      avatar: "https://img.example.com/a.jpg",
      postCount: 1509,
      followerCount: 4850008,
      followingCount: 73,
      isDel: 0,
    });
  });

  it("传入 categoryId 时透传到 payload", async () => {
    const result = await fetchTikTokProfilePayload({
      accountId: "@yua_mikami",
      categoryId: 6,
      runner: makeRunner({
        code: 0,
        stdout: JSON.stringify({
          uploader_id: "sec-1",
          title: "yua_mikami",
          channel: "三上悠亜",
          aweme_count: 3,
          channel_follower_count: 1,
          following_count: 2,
        }),
        stderr: "",
      }),
    });

    expect(result.categoryId).toBe(6);
  });

  it("命令失败时抛错", async () => {
    await expect(
      fetchTikTokProfilePayload({
        accountId: "@alice",
        runner: makeRunner({
          code: 2,
          stdout: "",
          stderr: "forbidden",
        }),
      }),
    ).rejects.toThrow("patch-yt-dlp 执行失败");
  });
});

describe("syncTikTokProfileBeforeFetch", () => {
  it("用户资料同步失败时直接阻断", async () => {
    await expect(
      syncTikTokProfileBeforeFetch(
        {
          accountId: "@alice",
          proxy: "http://127.0.0.1:2080",
        },
        {
          syncClient: {
            async syncStarProfile() {
              throw new Error("sync down");
            },
          },
          runner: makeRunner({
            code: 0,
            stdout: JSON.stringify({
              uploader_id: "1",
              uploader: "alice",
              channel: "Alice",
              aweme_count: 3,
              channel_follower_count: 1,
              following_count: 2,
            }),
            stderr: "",
          }),
        },
      ),
    ).rejects.toThrow("抓取前用户信息同步失败");
  });

  it("patch 输出缺少关键信息时阻断", async () => {
    await expect(
      syncTikTokProfileBeforeFetch(
        {
          accountId: "@newbie",
        },
        {
          syncClient: {
            async syncStarProfile() {
              // 不会执行到这里
            },
          },
          runner: makeRunner({
            code: 0,
            stdout: JSON.stringify({
              title: "newbie",
            }),
            stderr: "",
          }),
        },
      ),
    ).rejects.toThrow("抓取前用户信息同步失败");
  });

  it("会将头像上传到 COS 并在 payload 中仅保存 key", async () => {
    const putCalls: Array<{ Bucket: string; Region: string; Key: string }> = [];
    let syncedAvatar = "";

    await syncTikTokProfileBeforeFetch(
      {
        accountId: "@alice",
      },
      {
        syncClient: {
          async syncStarProfile(payload) {
            syncedAvatar = payload.avatar;
          },
        },
        runner: makeRunner({
          code: 0,
          stdout: JSON.stringify({
            uploader_id: "1",
            uploader: "alice",
            channel: "Alice",
            avatar_larger: "https://img.example.com/avatar.png",
            aweme_count: 3,
            channel_follower_count: 1,
            following_count: 2,
          }),
          stderr: "",
        }),
        avatarUpload: {
          cosClient: {
            async putObject(input: CosPutObjectInput) {
              putCalls.push({
                Bucket: input.Bucket,
                Region: input.Region,
                Key: input.Key,
              });
              return { ETag: "ok", Location: '' };
            },
          } as CosUploader,
          bucket: "bucket-1",
          region: "ap-guangzhou",
          keyPrefix: "profile",
          async fetchImpl() {
            return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
          },
        },
      },
    );

    expect(putCalls).toHaveLength(1);
    const firstCall = putCalls[0]!;
    expect(firstCall.Bucket).toBe("bucket-1");
    expect(firstCall.Region).toBe("ap-guangzhou");
    expect(firstCall.Key).toMatch(/^profile\/profile-avatar\/alice_\d+\.png$/);
    expect(syncedAvatar).toBe(firstCall.Key);
  });
});
