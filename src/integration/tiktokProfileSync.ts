import type { ProcessRunner } from "../types.ts";
import { debugLog } from "../logging/debugLogger.ts";
import { uploadRemoteUrlToCos } from "../upload/cosStreamUpload.ts";
import type { CosUploader } from "../upload/uploader.ts";
import type {
  InstarStarSyncClient,
  InstarStarSyncPayload,
} from "./instarServer.ts";

interface RawTikTokProfileFromYtDlp {
  /** MSID */
  id?: string;
  /** 用户名id 唯一 */
  title?: string;
  /** 上传者用户名 */
  uploader?: string;
  /** 上传者ID  6557999606692954114 */
  uploader_id?: string;
  /** 展示的用户名 */
  channel?: string;
  /** MSID */
  channel_id?: string;
  /** 头像（部分输出可能直接是 avatar） */
  avatar?: string;
  avatar_thumb?: string;
  avatar_medium?: string;
  avatar_larger?: string;
  /** 粉丝数 */
  channel_follower_count?: number;
  /** 关注数 */
  following_count?: number;
  /** 视频数 */
  aweme_count?: number;
}

export interface SyncTikTokProfileBeforeFetchInput {
  accountId: string;
  proxy?: string;
  traceId?: string;
  categoryId?: number;
}

interface ProfileAvatarUploadOptions {
  cosClient: CosUploader;
  bucket: string;
  region: string;
  keyPrefix?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface SyncTikTokProfileBeforeFetchDeps {
  syncClient: InstarStarSyncClient;
  runner: ProcessRunner;
  avatarUpload?: ProfileAvatarUploadOptions;
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

function toStringSafe(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function buildProfileUrl(accountId: string): string {
  const raw = accountId.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }

  const starName = normalizeStarName(raw);
  return `https://www.tiktok.com/@${starName}`;
}

function buildProfileArgs(accountId: string, proxy?: string): string[] {
  const args: string[] = [];
  if (proxy && proxy.trim().length > 0) {
    args.push("--proxy", proxy);
  }

  args.push(
    "--flat-playlist",
    "--playlist-items",
    "0",
    "-J",
    "--no-warnings",
    buildProfileUrl(accountId),
  );
  return args;
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeExtFromUrl(sourceUrl: string): string {
  try {
    const pathname = new URL(sourceUrl).pathname;
    const matched = pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
    if (matched?.[1]) {
      return matched[1].toLowerCase();
    }
  } catch {
    // ignore
  }
  return "jpg";
}

function buildAvatarObjectKey(starName: string, avatarUrl: string, keyPrefix = "tiktok-download"): string {
  const ext = normalizeExtFromUrl(avatarUrl);
  const safeStarName = safeSegment(starName);
  const safePrefix = safeSegment(keyPrefix).replace(/\/+$/g, "");
  const timestamp = Date.now();
  const keyBody = `profile-avatar/${safeStarName}_${timestamp}.${ext}`;
  if (safePrefix.length === 0) {
    return keyBody;
  }
  return `${safePrefix}/${keyBody}`;
}

function parseProfilePayload(
  raw: RawTikTokProfileFromYtDlp,
  accountId: string,
  categoryId?: number,
): InstarStarSyncPayload {
  const fallbackStarName = normalizeStarName(accountId);
  const insStarId =
    toStringSafe(raw.uploader_id) ||
    toStringSafe(raw.channel_id) ||
    toStringSafe(raw.id);
  const starName =
    toStringSafe(raw.uploader) || toStringSafe(raw.title) || fallbackStarName;
  const fullName = toStringSafe(raw.channel) || starName;
  const avatar = toStringSafe(
    raw.avatar_larger ?? raw.avatar_medium ?? raw.avatar_thumb ?? raw.avatar,
  );

  if (insStarId.length === 0 || starName.length === 0) {
    throw new Error("patch-yt-dlp 输出缺少 uploader_id/channel_id 与 starName");
  }

  return {
    insStarId,
    starName,
    fullName,
    zhName: fullName,
    avatar,
    postCount: toNumber(raw.aweme_count),
    followerCount: toNumber(raw.channel_follower_count ?? 0),
    followingCount: toNumber(raw.following_count ?? 0),
    ...(categoryId === undefined ? {} : { categoryId }),
    isDel: 0,
  };
}

export async function fetchTikTokProfilePayload(input: {
  accountId: string;
  proxy?: string;
  categoryId?: number;
  runner: ProcessRunner;
}): Promise<InstarStarSyncPayload> {
  const starName = normalizeStarName(input.accountId);
  if (starName.length === 0) {
    throw new Error("账号标识不能为空");
  }

  const args = buildProfileArgs(input.accountId, input.proxy);
  const result = await input.runner.run(args);
  if (result.code !== 0) {
    throw new Error(
      `patch-yt-dlp 执行失败(exit=${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  const jsonRaw = result.stdout.trim();
  if (jsonRaw.length === 0) {
    throw new Error("patch-yt-dlp 输出为空");
  }

  let data: RawTikTokProfileFromYtDlp;
  try {
    data = JSON.parse(jsonRaw) as RawTikTokProfileFromYtDlp;
  } catch {
    throw new Error("patch-yt-dlp 输出 JSON 解析失败");
  }

  return parseProfilePayload(data, input.accountId, input.categoryId);
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
      runner: deps.runner,
    });

    if (payload.avatar.length > 0 && deps.avatarUpload !== undefined) {
      const avatarObjectKey = buildAvatarObjectKey(
        payload.starName,
        payload.avatar,
        deps.avatarUpload.keyPrefix,
      );

      await uploadRemoteUrlToCos({
        sourceUrl: payload.avatar,
        cosClient: deps.avatarUpload.cosClient,
        bucket: deps.avatarUpload.bucket,
        region: deps.avatarUpload.region,
        key: avatarObjectKey,
        proxy: input.proxy,
        traceId: input.traceId,
        fetchImpl: deps.avatarUpload.fetchImpl,
      });

      payload.avatar = avatarObjectKey;
    }

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
