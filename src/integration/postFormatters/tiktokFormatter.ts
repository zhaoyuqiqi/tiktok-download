import type { InstarPost, PostFormatInput, Resource } from "./types.ts";

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

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = toStringOrUndefined(raw[key]);
    if (value !== undefined) {
      return value;
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

function buildFallbackStarName(starId: string): string {
  return starId.replace(/^@+/, "") || starId;
}

function resolveTitle(input: PostFormatInput, raw: Record<string, unknown>): string {
  return (
    input.title ??
    input.description ??
    pickString(raw, ["title", "description", "desc", "caption"]) ??
    ""
  );
}

function resolveResources(input: PostFormatInput, raw: Record<string, unknown>): Resource[] {
  const mediaUrl = toStringOrUndefined(input.videoUrl);
  const thumbnail = toStringOrUndefined(input.thumbnailUrl);
  const width = toNumberOrUndefined(raw.width) ?? toNumberOrUndefined(raw.video_width);
  const height = toNumberOrUndefined(raw.height) ?? toNumberOrUndefined(raw.video_height);

  if (input.mediaType === "image") {
    if (mediaUrl === undefined) {
      return [];
    }
    return [
      {
        type: "image",
        url: mediaUrl,
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
    pickString(raw, ["uploader", "author_handle", "authorHandle", "nickname", "author"]) ??
    input.authorHandle ??
    buildFallbackStarName(input.starId);

  const fullName = pickString(raw, ["channel", "nickname", "full_name", "fullName", "author", "uploader"]) ?? starName;

  const insStarId = pickString(raw, ["uploader_id", "channel_id", "sec_uid", "secUid"]) ?? input.starId;

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
