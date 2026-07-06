import { writeFile } from "node:fs/promises";
import { debugLog } from "../logging/debugLogger.ts";
import type { InstarStarSyncClient, InstarStarSyncPayload } from "./instarServer.ts";

type FetchWithProxy = (
  input: RequestInfo | URL,
  init?: RequestInit & {
    proxy?: string;
  },
) => Promise<Response>;

interface WebAppUserDetail {
  userInfo?: {
    user?: {
      id?: string;
      uniqueId?: string;
      nickname?: string;
      avatarLarger?: string;
      avatarMedium?: string;
      avatarThumb?: string;
    };
    stats?: {
      followerCount?: number;
      followingCount?: number;
      videoCount?: number;
    };
    statsV2: {
      followerCount?: number;
      followingCount?: number;
      videoCount?: number;
    };
  };
}
interface RawTikTokUserData {
  __DEFAULT_SCOPE__?: {
    "webapp.user-detail"?: WebAppUserDetail;
  };
}

export interface SyncTikTokProfileBeforeFetchInput {
  accountId: string;
  proxy?: string;
  traceId?: string;
  categoryId?: number;
}

export interface SyncTikTokProfileBeforeFetchDeps {
  syncClient: InstarStarSyncClient;
  fetchImpl?: FetchWithProxy;
}

function normalizeStarName(accountId: string): string {
  const raw = accountId.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    const pathname = new URL(raw).pathname;
    const matched = pathname.match(/@([^/?#]+)/);
    if (matched?.[1]) {
      return matched[1];
    }
  }

  return raw.startsWith("@") ? raw.slice(1) : raw;
}

function withProxy(
  proxy: string | undefined,
): RequestInit & { proxy?: string } {
  if (!proxy) {
    return {};
  }

  return {
    proxy,
  };
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.floor(parsed));
    }
  }

  return 0;
}

export async function fetchTikTokProfilePayload(input: {
  accountId: string;
  proxy?: string;
  categoryId?: number;
  fetchImpl?: FetchWithProxy;
}): Promise<InstarStarSyncPayload> {
  const starName = normalizeStarName(input.accountId);
  if (starName.length === 0) {
    throw new Error("账号标识不能为空");
  }

  const fetchImpl = input.fetchImpl ?? (fetch as FetchWithProxy);
  const response = await fetchImpl(
    `https://www.tiktok.com/@${starName}`,
    withProxy(input.proxy),
  );
  if (!response.ok) {
    throw new Error(
      `TikTok 用户页拉取失败: ${response.status} ${response.statusText}`,
    );
  }

  const html = await response.text();
  const USER_DETAIL_SCRIPT_RE =
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(.*?)<\/script>/s;
  const match = html.match(USER_DETAIL_SCRIPT_RE);
  if (!match?.[1]) {
    await writeFile("data/tiktokProfileSync.html", html);
    throw new Error(
      `TikTok ${starName} 用户页未找到 __UNIVERSAL_DATA_FOR_REHYDRATION__ 数据`,
    );
  }

  let data: RawTikTokUserData;
  try {
    data = JSON.parse(match[1]) as RawTikTokUserData;
  } catch {
    throw new Error("TikTok 用户页数据 JSON 解析失败");
  }

  const userDetail = data.__DEFAULT_SCOPE__?.["webapp.user-detail"] as
    | WebAppUserDetail
    | undefined;

  const user = userDetail?.userInfo?.user;
  const stats = userDetail?.userInfo?.stats;
  const statsV2 = userDetail?.userInfo?.statsV2;

  const insStarId = String(user?.id ?? "").trim();
  const profileStarName = String(user?.uniqueId ?? "").trim();
  if (insStarId.length === 0 || profileStarName.length === 0) {
    throw new Error("TikTok 用户数据缺少 id/uniqueId");
  }

  const fullName = String(user?.nickname ?? "").trim() || profileStarName;
  const avatar =
    String(user?.avatarLarger ?? "").trim() ||
    String(user?.avatarMedium ?? "").trim() ||
    String(user?.avatarThumb ?? "").trim();

  return {
    insStarId,
    starName: profileStarName,
    fullName,
    zhName: fullName,
    avatar,
    postCount: toNumber(stats?.videoCount ?? statsV2?.videoCount),
    followerCount: toNumber(stats?.followerCount ?? statsV2?.followerCount),
    followingCount: toNumber(stats?.followingCount ?? statsV2?.followingCount),
    ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
    isDel: 0,
  };
}

export async function syncTikTokProfileBeforeFetch(
  input: SyncTikTokProfileBeforeFetchInput,
  deps: SyncTikTokProfileBeforeFetchDeps,
): Promise<void> {
  const starName = normalizeStarName(input.accountId);

  try {
    const payload = await fetchTikTokProfilePayload({
      accountId: starName,
      proxy: input.proxy,
      categoryId: input.categoryId,
      fetchImpl: deps.fetchImpl,
    });

    await deps.syncClient.syncStarProfile(payload);

    debugLog("profile.sync.done", {
      traceId: input.traceId,
      accountId: input.accountId,
      starName,
      insStarId: payload.insStarId,
    });
  } catch (error) {
    throw new Error(
      `抓取前用户信息同步失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
