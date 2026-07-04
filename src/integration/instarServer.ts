import type { Post } from "../platforms/adapter.ts";

export interface UploadedMedia {
  objectKey: string;
  bucket: string;
  region: string;
}

export interface InstarServerPayload {
  platform: string;
  accountId: string;
  postId: string;
  title?: string;
  description?: string;
  publishedAt?: string;
  media: UploadedMedia;
}

export interface InstarServerClient {
  notifyPostIngested(payload: InstarServerPayload): Promise<void>;
}

export function toInstarServerPayload(post: Post, media: UploadedMedia): InstarServerPayload {
  return {
    platform: post.platform,
    accountId: post.accountId,
    postId: post.postId,
    title: post.title,
    description: post.description,
    publishedAt: post.publishedAt,
    media,
  };
}

export class NoopInstarServerClient implements InstarServerClient {
  async notifyPostIngested(_payload: InstarServerPayload): Promise<void> {
    // 预留实现：后续替换为真实 instar-server API 调用
  }
}
