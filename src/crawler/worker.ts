import path from "node:path";
import { Readable } from "node:stream";
import { sleep } from "bun";
import type { ClaimedAccountTask } from "../workers/protocol.ts";
import { Runner } from "./runner";
import type { InstarPost } from "./types/instar";
import type {
  InstarStarSyncPayload,
  PlatformPostRef,
  Post,
  RawDetailJson,
  RawTikTokProfileFromYtDlp,
  SetupOptions,
} from "./types/yt-dlp";
import { uploader } from "./uploader";
import { isImagePost } from "./utils/is";
import {
  buildCosObjectKey,
  ensureJson,
  formatTikTokPost,
  normalizeExtFromUrl,
  safeSegment,
  toIsoOrUndefined,
} from "./utils/normalize";
import { sleepRandom2000To8000 } from "./utils/sleep";

export interface AccountExecutionSummary extends Record<string, unknown> {
  outcome: "success" | "partial";
  newCount: number;
  failedCount: number;
  lastPostAt?: string;
  lastVideoId?: string;
}

export type WorkerLogLevel = "info" | "warn" | "error";
export type WorkerLogger = (
  level: WorkerLogLevel,
  event: string,
  fields?: Record<string, unknown>,
) => void;

export interface BaseWorkerOptions {
  idleWaitMs?: number;
  maxEmptyClaims?: number;
  sleep?: (delayMs: number) => Promise<void>;
  logger?: WorkerLogger;
  executeTask?: (
    task: ClaimedAccountTask,
  ) => Promise<AccountExecutionSummary>;
}

export abstract class BaseWorker {
  private readonly uploader = uploader;
  private readonly runner = new Runner(
    path.join(__dirname, "yt-dlp/patch-yt-dlp.sh"),
  );
  private readonly idleWaitMs: number;
  private readonly maxEmptyClaims: number;
  private readonly sleepImpl: (delayMs: number) => Promise<void>;
  private readonly logger?: WorkerLogger;
  private readonly executeTaskOverride?: BaseWorkerOptions["executeTask"];
  private taskContext: ClaimedAccountTask | null = null;

  protected constructor(options: BaseWorkerOptions = {}) {
    this.idleWaitMs = options.idleWaitMs ?? 10_000;
    this.maxEmptyClaims = options.maxEmptyClaims ?? 3;
    this.sleepImpl = options.sleep ?? sleep;
    this.logger = options.logger;
    this.executeTaskOverride = options.executeTask;

    if (this.idleWaitMs < 0 || this.maxEmptyClaims <= 0) {
      throw new Error("worker 空领等待参数无效");
    }
  }

  protected abstract onWorkerStart(): Promise<void>;
  protected abstract onWorkerEnd(): Promise<void>;
  protected abstract claimTasks(): Promise<ClaimedAccountTask | null>;
  protected abstract onTaskStart(task: ClaimedAccountTask): Promise<void>;
  protected abstract onTaskSuccess(
    task: ClaimedAccountTask,
    summary: AccountExecutionSummary,
  ): Promise<void>;
  protected abstract onTaskFailure(
    task: ClaimedAccountTask,
    error: unknown,
  ): Promise<void>;
  protected abstract onTaskEnd(task: ClaimedAccountTask): Promise<void>;
  protected abstract isExists(postId: string): Promise<boolean>;
  protected abstract syncStarProfile(
    payload: InstarStarSyncPayload,
  ): Promise<void>;
  protected abstract syncPostDetail(
    payload: InstarPost,
    publishedAt?: string,
  ): Promise<void>;
  protected abstract syncPostFailure(
    postId: string,
    error: string,
  ): Promise<void>;
  protected onPostStart?(_postId: string): Promise<void>;
  protected onPostEnd?(_postId: string): Promise<void>;

  protected log(
    level: WorkerLogLevel,
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    this.logger?.(level, event, {
      ...(this.taskContext === null
        ? {}
        : {
            taskId: this.taskContext.id,
            accountId: this.taskContext.accountId,
            source: this.taskContext.source,
          }),
      ...fields,
    });
  }

  private cookieArgs(): string[] {
    const cookiePath = process.env.COOKIE_PATH?.trim();
    return cookiePath ? ["--cookies", cookiePath] : [];
  }

  private async fetchProfile(starName: string) {
    const startedAt = Date.now();
    this.log("info", "profile.fetch.start", { accountId: starName });
    const args: string[] = [
      ...this.cookieArgs(),
      "--flat-playlist",
      "--playlist-items",
      "0",
      "-J",
      "--sleep-requests",
      "1",
      "--no-warnings",
      `https://www.tiktok.com/@${starName}`,
    ];
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new Error(
        `patch-yt-dlp 执行失败(exit=${result.code}): ${result.stderr || result.stdout}`,
      );
    }
    const jsonRaw = result.stdout.trim();
    if (jsonRaw.length === 0) {
      throw new Error("patch-yt-dlp 输出为空");
    }

    try {
      const profile = JSON.parse(jsonRaw) as RawTikTokProfileFromYtDlp;
      this.log("info", "profile.fetch.done", {
        accountId: starName,
        durationMs: Date.now() - startedAt,
        insStarId: profile.uploader_id ?? null,
      });
      return profile;
    } catch {
      throw new Error("patch-yt-dlp 输出 JSON 解析失败");
    }
  }

  private ytdlpProfileResponse2Instar(
    accountId: string,
    data: RawTikTokProfileFromYtDlp,
    zhName?: string,
    categoryId?: number,
  ): InstarStarSyncPayload {
    const starName = data.uploader || accountId || data.title || "";
    const insStarId = data.uploader_id ?? "";
    const fullName = data.channel || starName;
    const avatar =
      data.avatar_larger ??
      data.avatar_medium ??
      data.avatar_thumb ??
      data.avatar ??
      "";

    if (insStarId.length === 0 || starName.length === 0) {
      throw new Error(
        "patch-yt-dlp 输出缺少 uploader_id/channel_id 与 starName",
      );
    }

    return {
      insStarId,
      starName,
      fullName,
      ...(zhName === undefined ? {} : { zhName }),
      avatar,
      postCount: data.aweme_count ?? 0,
      followerCount: data.channel_follower_count ?? 0,
      followingCount: data.following_count ?? 0,
      ...(categoryId === undefined ? {} : { categoryId }),
      isDel: 0,
    };
  }

  private postDetailCleanse(detail: RawDetailJson, ref: PlatformPostRef): Post {
    const postId = detail.id?.trim() || ref.postId;
    const sourceUrl = detail.webpage_url ?? ref.url;
    const mediaType = detail.video_ext === "none" ? "image" : "video";
    const thumbnailUrl =
      detail.thumbnail ??
      detail.cover ??
      detail.cover_url ??
      detail.thumbnail_url ??
      "";

    return {
      platform: "tiktok",
      accountId: ref.accountId,
      postId,
      sourceUrl,
      title: detail.title ?? ref.title,
      description: detail.description,
      authorHandle: detail.uploader_id,
      publishedAt: toIsoOrUndefined(detail.timestamp),
      mediaType,
      videoExt: typeof detail.ext === "string" ? detail.ext : undefined,
      thumbnailUrl,
      rawDetail: detail,
    };
  }

  private async fetchPostList(starName: string, limit?: number) {
    const startedAt = Date.now();
    this.log("info", "post.list.fetch.start", {
      accountId: starName,
      limit: limit ?? null,
    });
    const args = [
      ...this.cookieArgs(),
      "--flat-playlist",
      "--sleep-requests",
      "2",
      "--print-json",
      "--lazy-playlist",
    ];
    if (limit !== undefined && limit > 0) {
      args.push("--playlist-end", String(limit));
    }
    args.push(`https://www.tiktok.com/@${starName}`);

    const entries = await this.runner.generateRun(args, (postId) =>
      this.isExists(postId),
    );
    const refs: PlatformPostRef[] = [];
    for (const entry of entries) {
      const postId = entry.id?.trim() ?? "";
      if (postId.length === 0) {
        continue;
      }
      const url =
        entry.webpage_url ??
        entry.url ??
        `https://www.tiktok.com/@${starName}/video/${postId}`;
      refs.push({
        platform: "tiktok",
        accountId: starName,
        postId,
        url,
        ...(entry.title === undefined ? {} : { title: entry.title }),
      });
    }
    this.log("info", "post.list.fetch.done", {
      accountId: starName,
      durationMs: Date.now() - startedAt,
      postCount: refs.length,
    });
    return refs;
  }

  private async fetchPostDetail(ref: PlatformPostRef) {
    const startedAt = Date.now();
    this.log("info", "post.detail.fetch.start", { postId: ref.postId });
    const result = await this.runner.run([
      ...this.cookieArgs(),
      "-J",
      ref.url,
    ]);
    if (result.code !== 0) {
      throw new Error(`yt-dlp 详情抓取失败: ${result.stderr || result.stdout}`);
    }
    const detail = ensureJson<RawDetailJson>(result.stdout, result.stderr);
    this.log("info", "post.detail.fetch.done", {
      postId: ref.postId,
      durationMs: Date.now() - startedAt,
    });
    return detail;
  }

  private buildAvatarObjectKey(
    starName: string,
    avatarUrl: string,
    keyPrefix = "tiktok-download",
  ): string {
    const ext = normalizeExtFromUrl(avatarUrl);
    const safePrefix = safeSegment(keyPrefix).replace(/\/+$/g, "");
    const keyBody = `profile-avatar/${starName}_${Date.now()}.${ext}`;
    return safePrefix.length === 0 ? keyBody : `${safePrefix}/${keyBody}`;
  }

  private async uploadRemoteUrl2Cos(url: string, key: string) {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(
        `远程资源下载失败: ${response.status} ${response.statusText}`,
      );
    }
    const body = Readable.from([Buffer.from(await response.arrayBuffer())]);
    return this.uploader.putObject({ Key: key, Body: body });
  }

  private async uploadPostStreamToCos(post: Post, key: string) {
    const media = await this.runner.runStream([
      ...this.cookieArgs(),
      "--no-playlist",
      "-o",
      "-",
      "--sleep-interval",
      "5",
      "--max-sleep-interval",
      "15",
      post.sourceUrl,
    ]);
    const putPromise = this.uploader.putObject({ Key: key, Body: media.stdout });
    const exitCode = await media.exited;
    if (exitCode !== 0) {
      throw new Error(`媒体流读取失败, exitCode=${exitCode}`);
    }
    await putPromise;
  }

  private async runLoggedUpload(
    fields: Record<string, unknown>,
    upload: () => Promise<unknown>,
  ): Promise<void> {
    const startedAt = Date.now();
    this.log("info", "cos.upload.start", fields);
    try {
      await upload();
      this.log("info", "cos.upload.done", {
        ...fields,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.log("error", "cos.upload.failed", {
        ...fields,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async handleProfile(options: SetupOptions) {
    const { zhName, starName, category } = options;
    const startedAt = Date.now();
    this.log("info", "profile.process.start", { accountId: starName });
    try {
      const profile = await this.fetchProfile(starName);
      const payload = this.ytdlpProfileResponse2Instar(
        starName,
        profile,
        zhName,
        category,
      );
      if (payload.avatar) {
        const avatarObjectKey = this.buildAvatarObjectKey(
          starName,
          payload.avatar,
        );
        await this.runLoggedUpload(
          {
            resourceType: "profile-avatar",
            objectKey: avatarObjectKey,
          },
          () => this.uploadRemoteUrl2Cos(payload.avatar, avatarObjectKey),
        );
        payload.avatar = avatarObjectKey;
      }
      await this.syncStarProfile(payload);
      this.log("info", "profile.process.done", {
        accountId: starName,
        durationMs: Date.now() - startedAt,
        insStarId: payload.insStarId,
      });
    } catch (error) {
      this.log("error", "profile.process.failed", {
        accountId: starName,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `抓取用户信息同步失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async uploadImagePostMedia(post: Post) {
    const imageObjectKey = buildCosObjectKey(post, {
      prefix: "fengniao",
      suffix: "image",
      ext: "jpg",
    });
    await this.runLoggedUpload(
      {
        postId: post.postId,
        resourceType: "post-image",
        objectKey: imageObjectKey,
      },
      () => this.uploadRemoteUrl2Cos(post.thumbnailUrl, imageObjectKey),
    );
    return { mediaUrl: imageObjectKey, thumbnailUrl: imageObjectKey };
  }

  private async uploadVideoPostMedia(post: Post) {
    const objectKey = buildCosObjectKey(post, { prefix: "fengniao" });
    await this.runLoggedUpload(
      {
        postId: post.postId,
        resourceType: "post-video",
        objectKey,
      },
      () => this.uploadPostStreamToCos(post, objectKey),
    );
    const thumbnailObjectKey = buildCosObjectKey(post, {
      prefix: "fengniao",
      suffix: "thumb",
      ext: "jpg",
    });
    await this.runLoggedUpload(
      {
        postId: post.postId,
        resourceType: "post-thumbnail",
        objectKey: thumbnailObjectKey,
      },
      () => this.uploadRemoteUrl2Cos(post.thumbnailUrl, thumbnailObjectKey),
    );
    return { mediaUrl: objectKey, thumbnailUrl: thumbnailObjectKey };
  }

  private async executeAccountTask(
    task: ClaimedAccountTask,
  ): Promise<AccountExecutionSummary> {
    const startedAt = Date.now();
    this.log("info", "account.crawl.start", {
      limit: task.options.limit ?? 100,
      categoryId: task.options.categoryId ?? null,
    });
    const setup: SetupOptions = {
      starName: task.accountId,
      ...(task.options.categoryId === undefined
        ? {}
        : { category: task.options.categoryId }),
      ...(task.options.zhName === undefined
        ? {}
        : { zhName: task.options.zhName }),
    };
    await this.handleProfile(setup);
    const refs = await this.fetchPostList(task.accountId, task.options.limit ?? 100);

    let newCount = 0;
    let failedCount = 0;
    let lastPostAt: string | undefined;
    let lastVideoId: string | undefined;

    for (const ref of refs) {
      if (await this.isExists(ref.postId)) {
        continue;
      }
      await this.onPostStart?.(ref.postId);
      const postStartedAt = Date.now();
      this.log("info", "post.process.start", { postId: ref.postId });
      try {
        const detail = await this.fetchPostDetail(ref);
        await sleepRandom2000To8000();
        const post = this.postDetailCleanse(detail, ref);
        const imageMode =
          post.mediaType === "image" || isImagePost(post.rawDetail);
        const mediaResult = await (imageMode
          ? this.uploadImagePostMedia(post)
          : this.uploadVideoPostMedia(post));
        const payload = formatTikTokPost({
          starId: post.accountId,
          postId: post.postId,
          mediaType: post.mediaType,
          videoUrl: mediaResult.mediaUrl,
          thumbnailUrl: mediaResult.thumbnailUrl,
          publishedAt: post.publishedAt,
          title: post.title,
          description: post.description,
          authorHandle: post.authorHandle,
          rawDetail: post.rawDetail,
        });
        await this.syncPostDetail(payload, post.publishedAt);
        newCount += 1;
        this.log("info", "post.process.done", {
          postId: ref.postId,
          mediaType: imageMode ? "image" : "video",
          durationMs: Date.now() - postStartedAt,
        });
        if (
          post.publishedAt !== undefined &&
          (lastPostAt === undefined || post.publishedAt > lastPostAt)
        ) {
          lastPostAt = post.publishedAt;
          lastVideoId = post.postId;
        }
      } catch (error) {
        failedCount += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.log("error", "post.process.failed", {
          postId: ref.postId,
          durationMs: Date.now() - postStartedAt,
          error: message,
        });
        await this.syncPostFailure(
          ref.postId,
          message,
        );
      } finally {
        await this.onPostEnd?.(ref.postId);
      }
    }

    if (failedCount > 0 && newCount === 0) {
      throw new Error(`账号内 ${failedCount} 个帖子全部处理失败`);
    }

    const summary: AccountExecutionSummary = {
      outcome: failedCount > 0 ? "partial" : "success",
      newCount,
      failedCount,
      ...(lastPostAt === undefined ? {} : { lastPostAt }),
      ...(lastVideoId === undefined ? {} : { lastVideoId }),
    };
    this.log("info", "account.crawl.done", {
      durationMs: Date.now() - startedAt,
      outcome: summary.outcome,
      newCount,
      failedCount,
    });
    return summary;
  }

  async autoSetup(): Promise<void> {
    await this.onWorkerStart();
    let emptyClaims = 0;
    try {
      while (emptyClaims < this.maxEmptyClaims) {
        const task = await this.claimTasks();
        if (task === null) {
          emptyClaims += 1;
          if (emptyClaims < this.maxEmptyClaims) {
            await this.sleepImpl(this.idleWaitMs);
          }
          continue;
        }

        emptyClaims = 0;
        this.taskContext = task;
        await this.onTaskStart(task);
        try {
          let summary: AccountExecutionSummary;
          try {
            summary = this.executeTaskOverride
              ? await this.executeTaskOverride(task)
              : await this.executeAccountTask(task);
          } catch (error) {
            await this.onTaskFailure(task, error);
            continue;
          }
          await this.onTaskSuccess(task, summary);
        } finally {
          await this.onTaskEnd(task);
          this.taskContext = null;
        }
      }
    } finally {
      await this.onWorkerEnd();
    }
  }
}
