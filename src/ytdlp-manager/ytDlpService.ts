import { access, readlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { currentLinkPath, resolveToolDir } from "./toolDir.ts";

const MISSING_HINT =
  "yt-dlp current 软链接不可用,请先运行更新任务(bun run src/ytdlp-manager/update.ts)";

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
}
