import { debugLog } from "../logging/debugLogger.ts";
import type { PlatformAdapter, Post } from "../platforms/adapter.ts";
import type { StateRepository } from "../storage/repository.ts";
import { uploadPostStreamToCos, uploadRemoteUrlToCos } from "../upload/cosStreamUpload.ts";
import { buildCosObjectKey } from "../upload/objectKey.ts";
import type { CosUploader } from "../upload/uploader.ts";
import { collectNewPostsStream } from "./fetchPipeline.ts";

export interface ComputeNextRunAtInput {
  now: Date;
  lastPostAt?: string | null;
  newPostsCount: number;
  minIntervalMinutes?: number;
  normalIntervalMinutes?: number;
  inactiveIntervalHours?: number;
  inactiveThresholdHours?: number;
}

/**
 * 根据账号活跃度计算下一次调度时间。
 * - 有新帖：最小间隔（默认 30 分钟）
 * - 无新帖：常规间隔（默认 60 分钟）
 * - 长时间不活跃：降频到更长间隔（默认 6 小时）
 *
 * @param input 计算参数
 * @returns 下一次运行时间（ISO 字符串）
 */
export function computeNextRunAt(input: ComputeNextRunAtInput): string {
  const minIntervalMinutes = input.minIntervalMinutes ?? 30;
  const normalIntervalMinutes = input.normalIntervalMinutes ?? 60;
  const inactiveIntervalHours = input.inactiveIntervalHours ?? 6;
  const inactiveThresholdHours = input.inactiveThresholdHours ?? 24;

  let delayMs = normalIntervalMinutes * 60_000;
  if (input.newPostsCount > 0) {
    delayMs = minIntervalMinutes * 60_000;
  } else if (input.lastPostAt) {
    const lastTs = Date.parse(input.lastPostAt);
    if (!Number.isNaN(lastTs)) {
      const idleMs = input.now.getTime() - lastTs;
      if (idleMs >= inactiveThresholdHours * 3_600_000) {
        delayMs = inactiveIntervalHours * 3_600_000;
      }
    }
  }

  return new Date(input.now.getTime() + delayMs).toISOString();
}

export interface MediaPipelineOptions {
  cosClient: CosUploader;
  bucket: string;
  region: string;
  keyPrefix?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface PostSyncedEvent {
  platform: string;
  source: "due" | "manual";
  starId: string;
  postId: string;
  sourceUrl: string;
  mediaType?: "video" | "image";
  videoUrl?: string;
  thumbnailUrl?: string;
  publishedAt?: string;
  title?: string;
  description?: string;
  authorHandle?: string;
  rawDetail?: Record<string, unknown>;
}

export interface RunAccountIngestInput {
  accountId: string;
  source: "due" | "manual";
  platform: string;
  repo: Pick<StateRepository, "getAccount" | "upsertAccount" | "isFetched" | "markFetched">;
  adapter: PlatformAdapter;
  media?: MediaPipelineOptions;
  proxy?: string;
  manualLimit?: number;
  manualCategoryId?: number;
  now?: () => Date;
  traceId?: string;
  beforeFetchPosts?: (input: {
    platform: string;
    accountId: string;
    source: "due" | "manual";
    proxy?: string;
    traceId?: string;
    categoryId?: number;
  }) => Promise<void>;
  onPostSynced?: (event: PostSyncedEvent) => Promise<void>;
}

export interface RunAccountIngestResult {
  accountId: string;
  source: "due" | "manual";
  listedCount: number;
  newCount: number;
  dedupSkippedCount: number;
  nextRunAt: string;
}

/**
 * 取两个发布时间中的较新值。
 *
 * @param current 当前记录的最新发布时间
 * @param next 新读取到的发布时间
 * @returns 更新后的最新发布时间
 */
function pickLatestPublishedAt(current: string | null, next?: string): string | null {
  if (!next) {
    return current;
  }

  if (current === null) {
    return next;
  }

  const currentTs = Date.parse(current);
  const nextTs = Date.parse(next);

  if (Number.isNaN(currentTs)) {
    return next;
  }
  if (Number.isNaN(nextTs)) {
    return current;
  }

  return nextTs > currentTs ? next : current;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

const THUMBNAIL_FIELD_KEYS = ["thumbnail", "thumbnail_url", "cover", "cover_url"] as const;
const IMAGE_SOURCE_FIELD_KEYS = [...THUMBNAIL_FIELD_KEYS, "url"] as const;

interface UploadedMediaResult {
  mediaUrl?: string;
  thumbnailUrl?: string;
}

function isImagePost(rawDetail: Record<string, unknown> | undefined): boolean {
  return rawDetail?.video_ext === "none";
}

async function uploadImagePostMedia(
  input: RunAccountIngestInput,
  post: Post,
  rawDetail: Record<string, unknown> | undefined,
): Promise<UploadedMediaResult> {
  const media = input.media;
  if (media === undefined) {
    return {};
  }

  const sourceImageUrl = post.thumbnailUrl ?? pickString(rawDetail ?? {}, [...IMAGE_SOURCE_FIELD_KEYS]);
  if (sourceImageUrl === undefined) {
    throw new Error(`图文贴缺少可上传图片资源: postId=${post.postId}`);
  }

  const imageObjectKey = buildCosObjectKey(post, {
    prefix: media.keyPrefix,
    suffix: "image",
    ext: "jpg",
  });

  await uploadRemoteUrlToCos({
    sourceUrl: sourceImageUrl,
    cosClient: media.cosClient,
    bucket: media.bucket,
    region: media.region,
    key: imageObjectKey,
    traceId: input.traceId,
    proxy: input.proxy,
    fetchImpl: media.fetchImpl,
  });

  return {
    mediaUrl: imageObjectKey,
    thumbnailUrl: imageObjectKey,
  };
}

async function uploadVideoPostMedia(
  input: RunAccountIngestInput,
  post: Post,
  rawDetail: Record<string, unknown> | undefined,
): Promise<UploadedMediaResult> {
  const media = input.media;
  if (media === undefined) {
    return {};
  }

  const objectKey = buildCosObjectKey(post, {
    prefix: media.keyPrefix,
  });

  await uploadPostStreamToCos({
    adapter: input.adapter,
    post,
    cosClient: media.cosClient,
    bucket: media.bucket,
    region: media.region,
    key: objectKey,
    proxy: input.proxy,
    traceId: input.traceId,
  });

  const sourceThumbnailUrl = post.thumbnailUrl ?? pickString(rawDetail ?? {}, [...THUMBNAIL_FIELD_KEYS]);
  if (sourceThumbnailUrl === undefined) {
    return { mediaUrl: objectKey };
  }

  const thumbnailObjectKey = buildCosObjectKey(post, {
    prefix: media.keyPrefix,
    suffix: "thumb",
    ext: "jpg",
  });

  await uploadRemoteUrlToCos({
    sourceUrl: sourceThumbnailUrl,
    cosClient: media.cosClient,
    bucket: media.bucket,
    region: media.region,
    key: thumbnailObjectKey,
    traceId: input.traceId,
    proxy: input.proxy,
    fetchImpl: media.fetchImpl,
  });

  return {
    mediaUrl: objectKey,
    thumbnailUrl: thumbnailObjectKey,
  };
}

async function uploadPostMedia(
  input: RunAccountIngestInput,
  post: Post,
  rawDetail: Record<string, unknown> | undefined,
  imageMode: boolean,
): Promise<UploadedMediaResult> {
  if (imageMode) {
    return uploadImagePostMedia(input, post, rawDetail);
  }

  return uploadVideoPostMedia(input, post, rawDetail);
}

function markPostFetchedSuccess(input: RunAccountIngestInput, post: Post, now: () => Date): void {
  input.repo.markFetched({
    platform: input.platform,
    postId: post.postId,
    publishedAt: post.publishedAt ?? null,
    status: "success",
    attempts: 1,
    fetchedAt: now().toISOString(),
  });
}

async function emitPostSynced(
  input: RunAccountIngestInput,
  post: Post,
  imageMode: boolean,
  mediaResult: UploadedMediaResult,
): Promise<void> {
  if (input.onPostSynced === undefined) {
    return;
  }

  await input.onPostSynced({
    platform: input.platform,
    source: input.source,
    starId: input.accountId,
    postId: post.postId,
    sourceUrl: post.sourceUrl,
    mediaType: imageMode ? "image" : "video",
    videoUrl: mediaResult.mediaUrl,
    thumbnailUrl: mediaResult.thumbnailUrl,
    publishedAt: post.publishedAt,
    title: post.title,
    description: post.description,
    authorHandle: post.authorHandle,
    rawDetail: post.rawDetail,
  });
}

/**
 * 执行单账号抓取编排：
 * 1) 流式抓取帖子详情
 * 2) 去重检查
 * 3) 可选上传 COS 并回调 instar
 * 4) 写入 fetched 与账号游标
 *
 * 该流程按帖子串行处理，保证不会引入单账号内并发冲突。
 *
 * @param input 执行参数
 * @returns 本次抓取统计结果
 */
export async function runAccountIngest(input: RunAccountIngestInput): Promise<RunAccountIngestResult> {
  const now = input.now ?? (() => new Date());
  const startedAt = now();
  const existing = input.repo.getAccount(input.platform, input.accountId);

  debugLog("ingest.start", {
    traceId: input.traceId,
    platform: input.platform,
    accountId: input.accountId,
    source: input.source,
    lastVideoId: existing?.lastVideoId ?? null,
  });

  let listedCount = 0;
  let dedupSkippedCount = 0;
  let newCount = 0;
  let latestListedPostId: string | undefined;
  let latestPublishedAt = existing?.lastPostAt ?? null;

  if (input.beforeFetchPosts !== undefined) {
    await input.beforeFetchPosts({
      platform: input.platform,
      accountId: input.accountId,
      source: input.source,
      proxy: input.proxy,
      traceId: input.traceId,
      categoryId: input.source === "manual" ? input.manualCategoryId : undefined,
    });
  }

  for await (const post of collectNewPostsStream(input.adapter, {
    accountId: input.accountId,
    lastVideoId: existing?.lastVideoId ?? undefined,
    limit: input.source === "manual" ? (input.manualLimit ?? 100) : undefined,
    proxy: input.proxy,
    traceId: input.traceId,
  })) {
    listedCount += 1;
    if (latestListedPostId === undefined) {
      latestListedPostId = post.postId;
    }
    latestPublishedAt = pickLatestPublishedAt(latestPublishedAt, post.publishedAt);

    if (input.repo.isFetched(input.platform, post.postId)) {
      dedupSkippedCount += 1;
      debugLog("ingest.post.skip_dedup", {
        traceId: input.traceId,
        platform: input.platform,
        accountId: input.accountId,
        postId: post.postId,
      });
      continue;
    }

    const rawDetail = post.rawDetail;
    const imageMode = post.mediaType === "image" || isImagePost(rawDetail);

    const mediaResult = await uploadPostMedia(input, post, rawDetail, imageMode);

    markPostFetchedSuccess(input, post, now);
    newCount += 1;

    await emitPostSynced(input, post, imageMode, mediaResult);

    debugLog("ingest.post.done", {
      traceId: input.traceId,
      platform: input.platform,
      accountId: input.accountId,
      postId: post.postId,
      publishedAt: post.publishedAt ?? null,
      syncedToInstar: input.onPostSynced !== undefined,
    });
  }

  const nextRunAt = computeNextRunAt({
    now: startedAt,
    lastPostAt: latestPublishedAt,
    newPostsCount: newCount,
  });

  input.repo.upsertAccount({
    platform: input.platform,
    accountId: input.accountId,
    nextRunAt,
    lastPostAt: latestPublishedAt,
    lastVideoId: latestListedPostId ?? existing?.lastVideoId ?? null,
    active: true,
  });

  const result: RunAccountIngestResult = {
    accountId: input.accountId,
    source: input.source,
    listedCount,
    newCount,
    dedupSkippedCount,
    nextRunAt,
  };

  debugLog("ingest.done", {
    traceId: input.traceId,
    platform: input.platform,
    accountId: input.accountId,
    source: input.source,
    listedCount: result.listedCount,
    newCount: result.newCount,
    dedupSkippedCount: result.dedupSkippedCount,
    nextRunAt: result.nextRunAt,
  });

  return result;
}
