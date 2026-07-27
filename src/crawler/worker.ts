import path from "node:path";
import { uploader } from "./uploader";
import type {
  InstarStarSyncPayload,
  PlatformPostRef,
  Post,
  RawDetailJson,
  RawTikTokProfileFromYtDlp,
  SetupOptions,
} from "./types/yt-dlp";
import { Runner } from "./runner";
import {
  buildCosObjectKey,
  ensureJson,
  formatTikTokPost,
  normalizeExtFromUrl,
  safeSegment,
  toIsoOrUndefined,
} from "./utils/normalize";
import { Readable } from "node:stream";
import { sleepRandom2000To8000 } from "./utils/sleep";
import { isImagePost } from "./utils/is";
import type { InstarPost } from "./types/instar";
import { sleep } from "bun";

abstract class AbstractWorker {
  /** 帖子是否存在或已抓取 */
  abstract isExists(postId: string): Promise<boolean>;
  /** 用户开始抓取 */
  abstract onStarStart?(starName: string): Promise<void>;
  /** 帖子开始抓取 */
  abstract onPostStart?(postId: string): Promise<void>;
  /** 帖子结束抓取 */
  abstract onPostEnd?(postId: string): Promise<void>;
  /** 用户抓取结束 */
  abstract onStarEnd?(starName: string): Promise<void>;

  /** 同步明星个人信息 */
  abstract syncStarProfile(payload: InstarStarSyncPayload): Promise<void>;
  /** 同步帖子信息 */
  abstract syncPostDetail(payload: InstarPost): Promise<void>;
  /** 领取抓取任务 返回的内容为用户的starName 即唯一标识 */
  abstract claimTasks(): Promise<string[]>;
}

export abstract class BaseWorker extends AbstractWorker {
  private uploader = uploader;
  private runner = new Runner(path.join(__dirname, "yt-dlp/patch-yt-dlp.sh"));
  /** 获取个人信息 */
  private async fetchProfile(starName: string) {
    const args: string[] = [
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

    let data: RawTikTokProfileFromYtDlp;
    try {
      data = JSON.parse(jsonRaw) as RawTikTokProfileFromYtDlp;
    } catch {
      throw new Error("patch-yt-dlp 输出 JSON 解析失败");
    }
    return data;
  }

  private ytdlpProfileResponse2Instar(
    accountId: string,
    data: RawTikTokProfileFromYtDlp,
    zhName?: string,
    categoryId?: number,
  ): InstarStarSyncPayload {
    const fallbackStarName = accountId;
    const insStarId = data.uploader_id ?? "";
    const starName = data.uploader || fallbackStarName || data.title || "";
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
    const raw = detail;
    const postId = raw.id?.trim() || ref.postId;
    const sourceUrl = raw.webpage_url ?? ref.url;

    const mediaType = raw.video_ext === "none" ? "image" : "video";
    const thumbnailUrl =
      raw.thumbnail ?? raw.cover ?? raw.cover_url ?? raw.thumbnail_url ?? "";

    return {
      platform: "tiktok",
      accountId: ref.accountId,
      postId,
      sourceUrl,
      title: raw.title ?? ref.title,
      description: raw.description,
      authorHandle: raw.uploader_id,
      publishedAt: toIsoOrUndefined(raw.timestamp),
      mediaType,
      videoExt: typeof raw.ext === "string" ? raw.ext : undefined,
      thumbnailUrl,
      rawDetail: detail,
    };
  }

  /** 获取列表 */
  private async fetchPostList(starName: string, limit?: number) {
    const args = [
      "--flat-playlist",
      "--sleep-requests",
      "2",
      "--print-json",
      "--lazy-playlist",
    ];
    if (limit) {
      args.push("--playlist-end", `${limit}`);
    }
    args.push(`https://www.tiktok.com/@${starName}`);
    const entries = await this.runner.generateRun(args, this.isExists);
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
      const ref: PlatformPostRef = {
        platform: "tiktok",
        accountId: starName,
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
  /** 获取详情 */
  private async fetchPostDetail(ref: PlatformPostRef) {
    const args = ["-J", ref.url];
    const result = await this.runner.run(args);
    if (result.code !== 0) {
      throw new Error(`yt-dlp 详情抓取失败: ${result.stderr || result.stdout}`);
    }
    return ensureJson<RawDetailJson>(result.stdout, result.stderr);
  }

  private buildAvatarObjectKey(
    starName: string,
    avatarUrl: string,
    keyPrefix = "tiktok-download",
  ): string {
    const ext = normalizeExtFromUrl(avatarUrl);
    const safePrefix = safeSegment(keyPrefix).replace(/\/+$/g, "");
    const timestamp = Date.now();
    const keyBody = `profile-avatar/${starName}_${timestamp}.${ext}`;
    if (safePrefix.length === 0) {
      return keyBody;
    }
    return `${safePrefix}/${keyBody}`;
  }

  private async uploadRemoteUrl2Cos(url: string, key: string) {
    const response = await fetch(url);
    if (!response.ok || response.body === null) {
      throw new Error(
        `远程资源下载失败: ${response.status} ${response.statusText}`,
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const body = Readable.from([buffer]);
    return this.uploader.putObject({
      Key: key,
      Body: body,
    });
  }

  private async uploadPostStreamToCos(post: Post, key: string) {
    const args = [
      "--no-playlist",
      "-o",
      "-",
      "--sleep-interval",
      "5",
      "--max-sleep-interval",
      "15",
      post.sourceUrl,
    ];
    const media = await this.runner.runStream(args);

    const putPromise = this.uploader.putObject({
      Key: key,
      Body: media.stdout,
    });
    const exitCode = await media.exited;
    if (exitCode !== 0) {
      throw new Error(`媒体流读取失败, exitCode=${exitCode}`);
    }
    await putPromise;
  }

  private async handleProfile(options: SetupOptions) {
    try {
      const { zhName, starName, category } = options;
      const profile = await this.fetchProfile(starName);
      const instarProfile = this.ytdlpProfileResponse2Instar(
        starName,
        profile,
        zhName,
        category,
      );
      if (instarProfile.avatar) {
        const avatarObjectKey = this.buildAvatarObjectKey(
          starName,
          instarProfile.avatar,
        );
        await this.uploadRemoteUrl2Cos(instarProfile.avatar, avatarObjectKey);
        instarProfile.avatar = avatarObjectKey;
      }
      await this.syncStarProfile(instarProfile);
    } catch (error) {
      throw new Error(
        `抓取用户信息同步失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async *collectNewPostsStream(options: SetupOptions) {
    const { starName } = options;
    const refs = await this.fetchPostList(starName, 100);
    for (const ref of refs) {
      if (await this.isExists(ref.postId)) {
        console.log("fetch.detail.skip_fetched", ref.postId);
        continue;
      }
      await this.onPostStart?.(ref.postId);
      const detail = await this.fetchPostDetail(ref);
      await sleepRandom2000To8000();
      const post = this.postDetailCleanse(detail, ref);
      yield post;
    }
  }

  private async handlePostDetail(options: SetupOptions) {
    try {
      for await (const post of this.collectNewPostsStream(options)) {
        const rawDetail = post.rawDetail;
        const imageMode = post.mediaType === "image" || isImagePost(rawDetail);

        const mediaResult = await (imageMode
          ? this.uploadImagePostMedia(post)
          : this.uploadVideoPostMedia(post));

        await this.syncPostDetail(
          formatTikTokPost({
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
          }),
        );
        await this.onPostEnd?.(post.postId);
      }
    } catch (error) {
      console.log(error);
      throw new Error("摘取详情失败");
    }
  }

  private async uploadImagePostMedia(post: Post) {
    const url = post.thumbnailUrl;
    const imageObjectKey = buildCosObjectKey(post, {
      prefix: "fengniao",
      suffix: "image",
      ext: "jpg",
    });
    await this.uploadRemoteUrl2Cos(url, imageObjectKey);
    return {
      mediaUrl: imageObjectKey,
      thumbnailUrl: imageObjectKey,
    };
  }
  private async uploadVideoPostMedia(post: Post) {
    const objectKey = buildCosObjectKey(post, {
      prefix: "fengniao",
    });
    await this.uploadPostStreamToCos(post, objectKey);
    const thumbnailObjectKey = buildCosObjectKey(post, {
      prefix: "fengniao",
      suffix: "thumb",
      ext: "jpg",
    });
    await this.uploadRemoteUrl2Cos(post.thumbnailUrl, thumbnailObjectKey);
    return {
      mediaUrl: objectKey,
      thumbnailUrl: thumbnailObjectKey,
    };
  }

  async autoSetup() {
    let times = 0;
    while (true) {
      const starNames = await this.claimTasks().catch(() => []);
      if (!starNames.length) {
        if (times >= 10) {
          // 10次都没有任务就结束
          return;
        }
        times++;
        await sleep(5 * 60_000);
        continue;
      }
      for (const starName of starNames) {
        try {
          await this.manualSetup({ starName });
        } catch (error) {
          console.log(starName + "抓取出错", error);
        }
      }
    }
  }
  // 手动更新
  async manualSetup(options: SetupOptions) {
    try {
      await this.onStarStart?.(options.starName);
      await this.handleProfile(options);
      await this.handlePostDetail(options);
    } catch (error) {
      console.log(error);
    } finally {
      await this.onStarEnd?.(options.starName);
    }
  }
}
