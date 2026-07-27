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