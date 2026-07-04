import type { ProcessStream } from "../types.ts";

export interface AdapterRequestOptions {
  proxy?: string;
}

export interface ListPostsOptions extends AdapterRequestOptions {
  limit?: number;
}

export interface PlatformPostRef {
  platform: string;
  accountId: string;
  postId: string;
  url: string;
  title?: string;
}

export interface Post {
  platform: string;
  accountId: string;
  postId: string;
  sourceUrl: string;
  title?: string;
  description?: string;
  authorHandle?: string;
  publishedAt?: string;
}

export interface PlatformAdapter {
  readonly platform: string;
  listPosts(accountId: string, options?: ListPostsOptions): Promise<PlatformPostRef[]>;
  fetchDetail(ref: PlatformPostRef, options?: AdapterRequestOptions): Promise<unknown>;
  cleanse(detail: unknown, ref: PlatformPostRef): Post;
  openMediaStream(post: Post, options?: AdapterRequestOptions): Promise<ProcessStream>;
}
