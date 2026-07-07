import { access, readlink } from "node:fs/promises";
import { isAbsolute, resolve, join } from "node:path";
import { currentLinkPath, currentSourceLinkPath, resolveToolDir } from "./toolDir.ts";

const MISSING_HINT =
  "yt-dlp current 软链接不可用,请先运行更新任务(bun run src/ytdlp-manager/update.ts)";

const MISSING_PATCH_HINT =
  "patched profile runner 不可用,请先运行更新任务准备源码与 patch 文件(bun run src/ytdlp-manager/update.ts)";

export class YtDlpService {
  private readonly toolDir: string;

  constructor(opts?: { toolDir?: string }) {
    this.toolDir = resolveToolDir(opts?.toolDir);
  }

  async getBinaryPath(): Promise<string> {
    const linkPath = currentLinkPath(this.toolDir);

    let target: string;
    try {
      target = await readlink(linkPath);
    } catch {
      throw new Error(`${MISSING_HINT}(缺少 current: ${linkPath})`);
    }

    const binPath = isAbsolute(target) ? target : resolve(this.toolDir, target);

    try {
      await access(binPath);
    } catch {
      throw new Error(`${MISSING_HINT}(current 目标不存在: ${binPath})`);
    }

    return binPath;
  }

  async getPatchedProfileRunnerPath(): Promise<string> {
    const linkPath = currentSourceLinkPath(this.toolDir);

    let target: string;
    try {
      target = await readlink(linkPath);
    } catch {
      throw new Error(`${MISSING_PATCH_HINT}(缺少 current-src: ${linkPath})`);
    }

    const sourceDir = isAbsolute(target) ? target : resolve(this.toolDir, target);
    const patchRunnerPath = join(sourceDir, "patch-yt-dlp.sh");

    try {
      await access(patchRunnerPath);
    } catch {
      throw new Error(`${MISSING_PATCH_HINT}(缺少 patch 脚本: ${patchRunnerPath})`);
    }

    return patchRunnerPath;
  }
}
