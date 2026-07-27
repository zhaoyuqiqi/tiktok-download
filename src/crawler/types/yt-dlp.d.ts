import type { ResourceType } from "./instar";

export interface SetupOptions {
  starName: string
  category?: number
  zhName?: string
}


export interface RawTikTokProfileFromYtDlp {
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


export interface InstarStarSyncPayload {
  insStarId: string;
  starName: string;
  fullName: string;
  avatar: string;
  postCount: number;
  followerCount: number;
  followingCount: number;
  categoryId?: number;
  zhName?: string;
  isDel: number;
}


export interface PostListItem {
  id: string;
  title?: string;
  webpage_url?: string;
  url?: string;
}

export interface PlatformPostRef {
  platform: string;
  accountId: string;
  postId: string;
  url: string;
  title?: string;
}


export interface RawDetailJson {
  id?: string;
  title?: string;
  description?: string;
  webpage_url?: string;
  uploader_id?: string;
  timestamp?: number;
  ext?: string;
  video_ext?: string;
  thumbnail?: string;
  cover?: string;
  cover_url?: string;
  thumbnail_url?: string;
  [key: string]: unknown;
}




// 详情

export interface Post {
  platform: string;
  accountId: string;
  postId: string;
  sourceUrl: string;
  title?: string;
  description?: string;
  authorHandle?: string;
  publishedAt?: string;
  mediaType: "video" | "image";
  videoExt?: string;
  thumbnailUrl: string;
  rawDetail: RawDetailJson;
}


export interface ProcessStream {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PostFormatInput {
  starId: string;
  postId: string;
  mediaType?: ResourceType;
  videoUrl?: string;
  thumbnailUrl?: string;
  publishedAt?: string;
  title?: string;
  description?: string;
  authorHandle?: string;
  rawDetail?: RawDetailJson;
}