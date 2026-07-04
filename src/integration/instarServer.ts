import { debugLog } from "../logging/debugLogger.ts";
import { formatPostByPlatform } from "./postFormatters/registry.ts";
import type { InstarPost, PostFormatInput } from "./postFormatters/types.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AccountCompletedPayload {
  starId: string;
  token: "instar";
  status: 0 | 1;
}

export type PostSyncedPayload = InstarPost;

export interface InstarServerClient {
  notifyAccountCompleted(payload: AccountCompletedPayload): Promise<void>;
}

export interface InstarPostSyncClient {
  notifyPostSynced(payload: PostSyncedPayload): Promise<void>;
}

export function toInstarAccountCompletedPayload(accountId: string, status: 0 | 1): AccountCompletedPayload {
  return {
    starId: accountId,
    token: "instar",
    status,
  };
}

export function toInstarPostSyncedPayload(input: PostFormatInput): PostSyncedPayload {
  return formatPostByPlatform(input);
}

export interface HttpInstarServerClientOptions {
  url: string;
  bearerToken?: string;
  fetchImpl?: FetchLike;
}

async function postJson(options: {
  url: string;
  payload: unknown;
  bearerToken?: string;
  fetchImpl: FetchLike;
  errorPrefix: string;
}): Promise<void> {
  const response = await options.fetchImpl(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
    },
    body: JSON.stringify(options.payload),
  });

  if (!response.ok) {
    throw new Error(`${options.errorPrefix}: ${response.status} ${response.statusText}`);
  }
}

export class HttpInstarServerClient implements InstarServerClient {
  private readonly url: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpInstarServerClientOptions) {
    this.url = options.url;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notifyAccountCompleted(payload: AccountCompletedPayload): Promise<void> {
    await postJson({
      url: this.url,
      payload,
      bearerToken: this.bearerToken,
      fetchImpl: this.fetchImpl,
      errorPrefix: "instar 回调失败",
    });
  }
}

export class HttpInstarPostSyncClient implements InstarPostSyncClient {
  private readonly url: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpInstarServerClientOptions) {
    this.url = options.url;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async notifyPostSynced(payload: PostSyncedPayload): Promise<void> {
    await postJson({
      url: this.url,
      payload,
      bearerToken: this.bearerToken,
      fetchImpl: this.fetchImpl,
      errorPrefix: "instar 帖子回调失败",
    });
    debugLog('instar 帖子回调成功')
  }
}

export class NoopInstarServerClient implements InstarServerClient {
  async notifyAccountCompleted(_payload: AccountCompletedPayload): Promise<void> {
    // 预留实现：未配置 webhook 时不执行外部调用
  }
}
