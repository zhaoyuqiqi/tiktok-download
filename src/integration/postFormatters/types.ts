export type ResourceType = "image" | "video";

export interface Resource {
  type: ResourceType;
  url: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
}

export interface InstarPost {
  insPostId: string;
  starName: string;
  fullName: string;
  title: string;
  isTop: boolean;
  insStarId: string;
  publishTime: number;
  resources: Resource[];
}

export interface PostFormatInput {
  platform: string;
  source?: "due" | "manual";
  starId: string;
  postId: string;
  sourceUrl: string;
  mediaType?: ResourceType;
  videoUrl?: string;
  thumbnailUrl?: string;
  publishedAt?: string;
  title?: string;
  description?: string;
  authorHandle?: string;
  rawDetail?: Record<string, unknown>;
}

export type PostFormatter = (input: PostFormatInput) => InstarPost;
