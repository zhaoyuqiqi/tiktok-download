import { Readable } from "node:stream";
import { debugLog } from "../logging/debugLogger.ts";
import type { PlatformAdapter, Post } from "../platforms/adapter.ts";
import type { CosUploader } from "./uploader.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CosPutObjectInput {
  Bucket: string;
  Region: string;
  Key: string;
  Body: NodeJS.ReadableStream;
}


export interface UploadPostStreamToCosInput {
  adapter: PlatformAdapter;
  post: Post;
  cosClient: CosUploader;
  bucket: string;
  region: string;
  key: string;
  proxy?: string;
  traceId?: string;
}

export interface UploadRemoteUrlToCosInput {
  sourceUrl: string;
  cosClient: CosUploader;
  bucket: string;
  region: string;
  key: string;
  traceId?: string;
  proxy?: string;
  fetchImpl?: FetchLike;
}

/**
 * 将单条帖子媒体流直接上传到 COS（不落地本地磁盘）。
 * 上传会同时等待：
 * 1) `yt-dlp` 流读取退出码为 0
 * 2) `putObject` 请求完成
 *
 * 任一失败都会抛错，由上游调度决定重试策略。
 *
 * @param input 上传参数
 */
export async function uploadPostStreamToCos(input: UploadPostStreamToCosInput): Promise<void> {
  debugLog("upload.stream.open.start", {
    traceId: input.traceId,
    platform: input.post.platform,
    accountId: input.post.accountId,
    postId: input.post.postId,
    key: input.key,
  });

  const media = await input.adapter.openMediaStream(input.post, {
    proxy: input.proxy,
  });

  debugLog("upload.stream.open.done", {
    traceId: input.traceId,
    platform: input.post.platform,
    accountId: input.post.accountId,
    postId: input.post.postId,
    key: input.key,
  });

  debugLog("upload.cos.put.start", {
    traceId: input.traceId,
    bucket: input.bucket,
    region: input.region,
    key: input.key,
  });

  const putPromise = Promise.resolve(
    input.cosClient.putObject({
      Bucket: input.bucket,
      Region: input.region,
      Key: input.key,
      Body: media.stdout,
    }),
  );

  const exitCode = await media.exited;
  debugLog("upload.stream.exit", {
    traceId: input.traceId,
    platform: input.post.platform,
    accountId: input.post.accountId,
    postId: input.post.postId,
    key: input.key,
    exitCode,
  });

  if (exitCode !== 0) {
    throw new Error(`媒体流读取失败, exitCode=${exitCode}`);
  }

  await putPromise;
  debugLog("upload.cos.put.done", {
    traceId: input.traceId,
    bucket: input.bucket,
    region: input.region,
    key: input.key,
  });
}

function withProxy(proxy: string | undefined, init: RequestInit = {}): RequestInit & { proxy?: string } {
  if (proxy === undefined || proxy.length === 0) {
    return init as RequestInit & { proxy?: string };
  }

  return {
    ...init,
    proxy,
  } as RequestInit & { proxy?: string };
}

export async function uploadRemoteUrlToCos(input: UploadRemoteUrlToCosInput): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch;

  debugLog("upload.remote.fetch.start", {
    traceId: input.traceId,
    sourceUrl: input.sourceUrl,
    key: input.key,
  });

  const response = await fetchImpl(input.sourceUrl, withProxy(input.proxy));
  if (!response.ok || response.body === null) {
    throw new Error(`远程资源下载失败: ${response.status} ${response.statusText}`);
  }

  debugLog("upload.remote.fetch.done", {
    traceId: input.traceId,
    sourceUrl: input.sourceUrl,
    key: input.key,
  });

  const buffer = Buffer.from(await response.arrayBuffer());
  const body = Readable.from([buffer]);

  debugLog("upload.cos.put.start", {
    traceId: input.traceId,
    bucket: input.bucket,
    region: input.region,
    key: input.key,
  });

  await Promise.resolve(
    input.cosClient.putObject({
      Bucket: input.bucket,
      Region: input.region,
      Key: input.key,
      Body: body,
    }),
  );

  debugLog("upload.cos.put.done", {
    traceId: input.traceId,
    bucket: input.bucket,
    region: input.region,
    key: input.key,
  });
}
