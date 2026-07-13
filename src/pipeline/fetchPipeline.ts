import { debugLog } from "../logging/debugLogger.ts";
import type { PlatformAdapter, PlatformPostRef, Post } from "../platforms/adapter.ts";

export interface FetchPipelineOptions {
  accountId: string;
  lastVideoId?: string;
  limit?: number;
  proxy?: string;
  traceId?: string;
  isFetched?: (platform: string, postId: string) => boolean;
  onPendingRef?: (ref: PlatformPostRef) => void;
  onSkippedFetched?: (ref: PlatformPostRef) => void;
}

/**
 * 将帖子发布时间转换为可排序的时间戳。
 * 当时间为空或非法时返回正无穷，确保排序时落到队尾。
 *
 * @param value ISO 时间字符串
 * @returns 可用于比较的时间戳
 */
function toTimestamp(value?: string): number {
  if (value === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * 拉取账号帖子引用并根据 `lastVideoId` 截断出待处理列表。
 *
 * @param adapter 平台适配器
 * @param options 抓取参数
 * @returns 需要继续抓详情的帖子引用数组（新到旧顺序）
 */
async function listPendingRefs(adapter: PlatformAdapter, options: FetchPipelineOptions): Promise<PlatformPostRef[]> {
  debugLog("fetch.list.start", {
    traceId: options.traceId,
    platform: adapter.platform,
    accountId: options.accountId,
    limit: options.limit ?? null,
  });

  const refs = await adapter.listPosts(options.accountId, {
    limit: options.limit,
    proxy: options.proxy,
  });

  debugLog("fetch.list.done", {
    traceId: options.traceId,
    platform: adapter.platform,
    accountId: options.accountId,
    listedCount: refs.length,
    lastVideoId: options.lastVideoId ?? null,
  });

  const pendingRefs = options.lastVideoId
    ? refs.slice(0, Math.max(0, refs.findIndex((item) => item.postId === options.lastVideoId)))
    : refs;

  debugLog("fetch.pending_refs", {
    traceId: options.traceId,
    platform: adapter.platform,
    accountId: options.accountId,
    pendingCount: pendingRefs.length,
  });

  return pendingRefs;
}

/**
 * 按发布时间对帖子从旧到新排序。
 *
 * @param posts 标准化帖子数组
 * @returns 新数组（不会修改入参）
 */
export function sortPostsByPublishedAt(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => toTimestamp(a.publishedAt) - toTimestamp(b.publishedAt));
}

/**
 * 以流式方式逐条产出新帖子。
 * 每获取一条详情就 `yield` 一条标准化 Post，便于下游边抓边处理。
 *
 * @param adapter 平台适配器
 * @param options 抓取参数
 * @yields 标准化后的帖子
 */
export async function* collectNewPostsStream(
  adapter: PlatformAdapter,
  options: FetchPipelineOptions,
): AsyncGenerator<Post> {
  const pendingRefs = await listPendingRefs(adapter, options);

  for (const ref of pendingRefs) {
    options.onPendingRef?.(ref);

    if (options.isFetched?.(adapter.platform, ref.postId) === true) {
      options.onSkippedFetched?.(ref);
      debugLog("fetch.detail.skip_fetched", {
        traceId: options.traceId,
        platform: adapter.platform,
        accountId: options.accountId,
        postId: ref.postId,
      });
      continue;
    }

    debugLog("fetch.detail.start", {
      traceId: options.traceId,
      platform: adapter.platform,
      accountId: options.accountId,
      postId: ref.postId,
    });

    const detail = await adapter.fetchDetail(ref, { proxy: options.proxy });
    const post = adapter.cleanse(detail, ref);

    debugLog("fetch.detail.done", {
      traceId: options.traceId,
      platform: adapter.platform,
      accountId: options.accountId,
      postId: post.postId,
      publishedAt: post.publishedAt ?? null,
    });

    yield post;
  }
}

/**
 * 向后兼容的批量收集函数。
 * 内部通过 `collectNewPostsStream` 收集后再统一排序返回。
 *
 * @param adapter 平台适配器
 * @param options 抓取参数
 * @returns 按发布时间升序的帖子数组
 */
export async function collectNewPosts(
  adapter: PlatformAdapter,
  options: FetchPipelineOptions,
): Promise<Post[]> {
  const posts: Post[] = [];
  for await (const post of collectNewPostsStream(adapter, options)) {
    posts.push(post);
  }

  const sorted = sortPostsByPublishedAt(posts);
  debugLog("fetch.done", {
    traceId: options.traceId,
    platform: adapter.platform,
    accountId: options.accountId,
    postCount: sorted.length,
  });

  return sorted;
}
