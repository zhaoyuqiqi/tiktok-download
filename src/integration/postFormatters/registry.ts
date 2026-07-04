import { formatTikTokPost } from "./tiktokFormatter.ts";
import type { InstarPost, PostFormatInput, PostFormatter } from "./types.ts";

const formatterRegistry: Record<string, PostFormatter> = {
  tiktok: formatTikTokPost,
};

export function formatPostByPlatform(input: PostFormatInput): InstarPost {
  const formatter = formatterRegistry[input.platform];
  if (formatter === undefined) {
    throw new Error(`未找到平台帖子格式化器: ${input.platform}`);
  }
  return formatter(input);
}
