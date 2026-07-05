import { describe, expect, it } from "bun:test";
import { fetchTikTokProfilePayload, syncTikTokProfileBeforeFetch } from "./tiktokProfileSync.ts";

function buildTikTokHtml(payload: unknown): string {
  return `<html><head></head><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
    payload,
  )}</script></body></html>`;
}

describe("fetchTikTokProfilePayload", () => {
  it("可从用户页脚本提取资料并映射为 instar 同步结构", async () => {
    const result = await fetchTikTokProfilePayload({
      accountId: "@yua_mikami",
      proxy: "http://127.0.0.1:2080",
      fetchImpl: async (_url, init) => {
        expect(init?.proxy).toBe("http://127.0.0.1:2080");
        return new Response(
          buildTikTokHtml({
            __DEFAULT_SCOPE__: {
              "webapp.user-detail": {
                userInfo: {
                  user: {
                    id: "6557999606692954114",
                    uniqueId: "yua_mikami",
                    nickname: "三上悠亜",
                    avatarLarger: "https://img.example.com/a.jpg",
                  },
                  statsV2: {
                    followerCount: "4850008",
                    followingCount: "73",
                    videoCount: "1509",
                  },
                },
              },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "text/html" },
          },
        );
      },
    });

    expect(result).toEqual({
      insStarId: "6557999606692954114",
      starName: "yua_mikami",
      fullName: "三上悠亜",
      zhName: "三上悠亜",
      avatar: "https://img.example.com/a.jpg",
      postCount: 1509,
      followerCount: 4850008,
      followingCount: 73,
      isDel: 0,
    });
    expect(result.categoryId).toBeUndefined();
  });

  it("传入 categoryId 时优先使用该分类", async () => {
    const result = await fetchTikTokProfilePayload({
      accountId: "@yua_mikami",
      categoryId: 6,
      fetchImpl: async () =>
        new Response(
          buildTikTokHtml({
            __DEFAULT_SCOPE__: {
              "webapp.user-detail": {
                userInfo: {
                  user: {
                    id: "6557999606692954114",
                    uniqueId: "yua_mikami",
                    nickname: "三上悠亜",
                  },
                  stats: {
                    followerCount: 1,
                    followingCount: 2,
                    videoCount: 3,
                  },
                },
              },
            },
          }),
          { status: 200 },
        ),
    });

    expect(result.categoryId).toBe(6);
  });
});

describe("syncTikTokProfileBeforeFetch", () => {
  it("已存在用户同步失败时不阻断", async () => {
    await expect(
      syncTikTokProfileBeforeFetch(
        {
          accountId: "@alice",
          proxy: "http://127.0.0.1:2080",
        },
        {
          existsClient: {
            async isStarExists() {
              return true;
            },
          },
          syncClient: {
            async syncStarProfile() {
              throw new Error("sync down");
            },
          },
          fetchImpl: async () =>
            new Response(
              buildTikTokHtml({
                __DEFAULT_SCOPE__: {
                  "webapp.user-detail": {
                    userInfo: {
                      user: {
                        id: "1",
                        uniqueId: "alice",
                        nickname: "Alice",
                        avatarLarger: "https://img.example.com/a.jpg",
                      },
                      stats: {
                        followerCount: 1,
                        followingCount: 2,
                        videoCount: 3,
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            ),
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("新用户同步失败时阻断", async () => {
    await expect(
      syncTikTokProfileBeforeFetch(
        {
          accountId: "@newbie",
        },
        {
          existsClient: {
            async isStarExists() {
              return false;
            },
          },
          syncClient: {
            async syncStarProfile() {
              throw new Error("sync failed");
            },
          },
          fetchImpl: async () =>
            new Response(
              buildTikTokHtml({
                __DEFAULT_SCOPE__: {
                  "webapp.user-detail": {
                    userInfo: {
                      user: {
                        id: "2",
                        uniqueId: "newbie",
                        nickname: "New User",
                        avatarLarger: "https://img.example.com/b.jpg",
                      },
                      stats: {
                        followerCount: 1,
                        followingCount: 2,
                        videoCount: 3,
                      },
                    },
                  },
                },
              }),
              { status: 200 },
            ),
        },
      ),
    ).rejects.toThrow("抓取前用户信息同步失败");
  });
});
