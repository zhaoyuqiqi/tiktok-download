import type { InstarPost, Resource } from "../types/instar";
import type { Post, PostFormatInput, RawDetailJson } from "../types/yt-dlp";

export function normalizeExtFromUrl(sourceUrl: string): string {
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

export function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toIsoOrUndefined(
  timestamp: number | undefined,
): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp * 1000).toISOString();
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatTimestamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join("");
}

function normalizeExt(value?: string): string {
  const raw = value?.trim().replace(/^\.+/, "") ?? "";
  if (raw.length === 0) {
    return "mp4";
  }
  const safe = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return safe.length > 0 ? safe : "mp4";
}

export function buildCosObjectKey(
  post: Post,
  options?: {
    prefix?: string;
    suffix?: string;
    ext?: string;
  },
): string {
  const date = post.publishedAt ? new Date(post.publishedAt) : new Date(0);
  const timestamp = formatTimestamp(date);
  const postId = safeSegment(post.postId);
  const platform = safeSegment(post.platform);
  const accountId = safeSegment(post.accountId);
  const prefix = options?.prefix?.trim() ?? "";
  const ext = normalizeExt(options?.ext ?? post.videoExt);
  const suffix = options?.suffix?.trim() ?? "";
  const suffixPart = suffix.length > 0 ? `_${safeSegment(suffix)}` : "";

  const filename = `${timestamp}_${postId}${suffixPart}.${ext}`;
  const body = `${platform}/${accountId}/${filename}`;
  if (prefix.length === 0) {
    return body;
  }
  return `${safeSegment(prefix).replace(/\/+$/g, "")}/${body}`;
}

export function ensureJson<T>(stdout: string, stderr: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`无法解析 yt-dlp 输出: ${stderr || stdout}`);
  }
}
function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}
function pickString(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = toStringOrUndefined(raw[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function buildFallbackStarName(starId: string): string {
  return starId.replace(/^@+/, "") || starId;
}

function resolveTitle(
  input: PostFormatInput,
  raw: Record<string, unknown>,
): string {
  return (
    input.title ??
    input.description ??
    pickString(raw, ["title", "description", "desc", "caption"]) ??
    ""
  );
}
function toNumberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}
function resolvePublishTime(input: PostFormatInput): number {
  const raw = input.rawDetail ?? {};
  const rawTimestamp = toNumberOrUndefined(raw.timestamp);
  if (rawTimestamp !== undefined) {
    return Math.trunc(rawTimestamp);
  }

  if (input.publishedAt !== undefined) {
    const ts = Date.parse(input.publishedAt);
    if (!Number.isNaN(ts)) {
      return Math.trunc(ts / 1000);
    }
  }

  return 0;
}
function resolveResources(
  input: PostFormatInput,
  raw: RawDetailJson,
): Resource[] {
  const mediaUrl = toStringOrUndefined(input.videoUrl);
  const thumbnail = toStringOrUndefined(input.thumbnailUrl);
  const width =
    toNumberOrUndefined(raw.width) ?? toNumberOrUndefined(raw.video_width);
  const height =
    toNumberOrUndefined(raw.height) ?? toNumberOrUndefined(raw.video_height);

  if (input.mediaType === "image") {
    if (mediaUrl === undefined) {
      return [];
    }
    return [
      {
        type: "image",
        url: mediaUrl,
        thumbnail_url: thumbnail,
        width,
        height,
      },
    ];
  }

  if (mediaUrl !== undefined) {
    return [
      {
        type: "video",
        url: mediaUrl,
        thumbnail_url: thumbnail,
        width,
        height,
      },
    ];
  }

  return [];
}

export function formatTikTokPost(input: PostFormatInput): InstarPost {
  const raw = input.rawDetail ?? {};

  const starName =
    pickString(raw, [
      "uploader",
      "author_handle",
      "authorHandle",
      "nickname",
      "author",
    ]) ??
    input.authorHandle ??
    buildFallbackStarName(input.starId);

  const fullName =
    pickString(raw, [
      "channel",
      "nickname",
      "full_name",
      "fullName",
      "author",
      "uploader",
    ]) ?? starName;

  const insStarId =
    pickString(raw, ["uploader_id", "channel_id", "sec_uid", "secUid"]) ??
    input.starId;

  return {
    insPostId: input.postId,
    starName,
    fullName,
    title: resolveTitle(input, raw),
    isTop: Boolean(raw.is_top ?? raw.isTop ?? raw.pinned),
    insStarId,
    publishTime: resolvePublishTime(input),
    resources: resolveResources(input, raw),
  };
}
