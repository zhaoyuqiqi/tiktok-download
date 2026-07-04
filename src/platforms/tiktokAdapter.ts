import type { ProcessRunner } from "../types.ts";
import type {
  AdapterRequestOptions,
  ListPostsOptions,
  PlatformAdapter,
  PlatformPostRef,
  Post,
} from "./adapter.ts";

interface RawListEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
}

interface RawListJson {
  entries?: RawListEntry[];
}

interface RawDetailJson {
  id?: string;
  title?: string;
  description?: string;
  webpage_url?: string;
  uploader_id?: string;
  timestamp?: number;
}

export interface TikTokAdapterOptions {
  requestDelayRangeMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function accountToProfileUrl(accountId: string): string {
  if (accountId.startsWith("http://") || accountId.startsWith("https://")) {
    return accountId;
  }

  if (accountId.startsWith("@")) {
    return `https://www.tiktok.com/${accountId}`;
  }

  return `https://www.tiktok.com/@${accountId}`;
}

function ensureJson<T>(stdout: string, stderr: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`无法解析 yt-dlp 输出: ${stderr || stdout}`);
  }
}

function toIsoOrUndefined(timestamp: number | undefined): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp * 1000).toISOString();
}

function pickDelayMs(range: [number, number], random: () => number): number {
  const [min, max] = range;
  if (max <= min) {
    return min;
  }
  return Math.floor(min + random() * (max - min));
}

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok";

  private readonly requestDelayRangeMs: [number, number];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(
    private readonly runner: ProcessRunner,
    options: TikTokAdapterOptions = {},
  ) {
    this.requestDelayRangeMs = options.requestDelayRangeMs ?? [2_000, 8_000];
    this.sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
    this.random = options.random ?? Math.random;
  }

  private async waitBeforeRequest(): Promise<void> {
    const delay = pickDelayMs(this.requestDelayRangeMs, this.random);
    if (delay > 0) {
      await this.sleep(delay);
    }
  }

  async listPosts(accountId: string, options?: ListPostsOptions): Promise<PlatformPostRef[]> {
    const args = ["-J", "--flat-playlist"];
    if (options?.limit !== undefined) {
      args.push("-I", `:${options.limit}`);
    }
    if (options?.proxy !== undefined) {
      args.push("--proxy", options.proxy);
    }
    args.push(accountToProfileUrl(accountId));

    await this.waitBeforeRequest();
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new Error(`yt-dlp 列表抓取失败: ${result.stderr || result.stdout}`);
    }

    const data = ensureJson<RawListJson>(result.stdout, result.stderr);
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const refs: PlatformPostRef[] = [];
    for (const entry of entries) {
      const postId = entry.id?.trim() ?? "";
      if (postId.length === 0) {
        continue;
      }

      const url = entry.webpage_url ?? entry.url ?? `https://www.tiktok.com/@${accountId}/video/${postId}`;
      const ref: PlatformPostRef = {
        platform: this.platform,
        accountId,
        postId,
        url,
      };
      if (entry.title !== undefined) {
        ref.title = entry.title;
      }
      refs.push(ref);
    }

    return refs;
  }

  async fetchDetail(ref: PlatformPostRef, options?: AdapterRequestOptions): Promise<unknown> {
    const args = ["-J"];
    if (options?.proxy !== undefined) {
      args.push("--proxy", options.proxy);
    }
    args.push(ref.url);

    await this.waitBeforeRequest();
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new Error(`yt-dlp 详情抓取失败: ${result.stderr || result.stdout}`);
    }

    return ensureJson<RawDetailJson>(result.stdout, result.stderr);
  }

  cleanse(detail: unknown, ref: PlatformPostRef): Post {
    const raw = detail as RawDetailJson;
    const postId = raw.id?.trim() || ref.postId;
    const sourceUrl = raw.webpage_url ?? ref.url;

    return {
      platform: this.platform,
      accountId: ref.accountId,
      postId,
      sourceUrl,
      title: raw.title ?? ref.title,
      description: raw.description,
      authorHandle: raw.uploader_id,
      publishedAt: toIsoOrUndefined(raw.timestamp),
    };
  }

  async openMediaStream(post: Post, options?: AdapterRequestOptions) {
    const args = ["--no-playlist", "-o", "-"];
    if (options?.proxy !== undefined) {
      args.push("--proxy", options.proxy);
    }
    args.push(post.sourceUrl);

    await this.waitBeforeRequest();
    return this.runner.runStream(args);
  }
}
