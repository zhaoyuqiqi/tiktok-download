import type { Post } from "../platforms/adapter.ts";

interface BuildCosObjectKeyOptions {
  prefix?: string;
  ext?: string;
  suffix?: string;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatTimestamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
  ].join("");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeExt(value?: string): string {
  const raw = value?.trim().replace(/^\.+/, "") ?? "";
  if (raw.length === 0) {
    return "mp4";
  }
  const safe = raw.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
  return safe.length > 0 ? safe : "mp4";
}

export function buildCosObjectKey(post: Post, options?: BuildCosObjectKeyOptions): string {
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
