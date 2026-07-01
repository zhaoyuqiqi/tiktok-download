import type { Config, Task, VideoInfo } from "./types.ts";
import { YtDlpRunner } from "./ytdlp-manager/runner.ts";
import { ensureYtDlp } from "./ytdlp-manager/ytDlpManager.ts";
import { parse } from "./parsing/parser.ts";
import { createTask, TaskQueue } from "./scheduling/task.ts";
import { download } from "./ytdlp-manager/worker.ts";
import { runScheduler } from "./scheduling/scheduler.ts";
import { NoopUploader } from "./upload/uploader.ts";

export function parseArgs(argv: string[]): Config {
  let url: string | undefined;
  let limit: number | undefined;
  let workers = 2;
  let retry = 2;
  let outputDir = "./output";
  let proxy: string | undefined;

  function numArg(name: string, raw: string | undefined): number {
    const n = Number(raw);
    if (raw === undefined || !Number.isFinite(n)) {
      throw new Error(`${name} 需要一个数值,收到: ${raw ?? "(空)"}`);
    }
    return n;
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--limit":
        limit = numArg("--limit", argv[++i]);
        break;
      case "--workers":
        workers = numArg("--workers", argv[++i]);
        break;
      case "--retry":
        retry = numArg("--retry", argv[++i]);
        break;
      case "-o":
      case "--output":
        outputDir = argv[++i] ?? outputDir;
        break;
      case "--proxy":
        proxy = argv[++i];
        break;
      default:
        if (arg !== undefined && !arg.startsWith("-")) {
          url = arg;
        }
    }
  }

  if (url === undefined) {
    throw new Error("用法: download <url> [--limit N] [--workers 2] [--retry 2] [-o ./output] [--proxy URL]");
  }

  return { url, limit, workers, retry, outputDir, proxy };
}

export async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  let ytDlp;
  try {
    ytDlp = await ensureYtDlp({ toolDir: process.env.YT_DLP_TOOL_DIR });
    if (ytDlp.updated) {
      console.log(`yt-dlp 已升级到 ${ytDlp.latestVersion}`);
    } else {
      console.log(`yt-dlp 版本已是最新: ${ytDlp.latestVersion}`);
    }
  } catch (err) {
    console.error("初始化 yt-dlp 失败:", (err as Error).message);
    process.exit(1);
  }

  const runner = new YtDlpRunner(ytDlp.currentPath);

  let videos: VideoInfo[];
  try {
    videos = await parse(runner, cfg.url, cfg.limit, cfg.proxy);
  } catch (err) {
    console.error("解析失败:", (err as Error).message);
    process.exit(1);
  }

  const queue = new TaskQueue(videos.map(createTask));
  const uploader = new NoopUploader();

  const summary = await runScheduler(
    queue,
    { workers: cfg.workers, retry: cfg.retry },
    (task: Task) => download(runner, task, cfg.outputDir, cfg.proxy),
    uploader,
  );

  console.log(`成功 ${summary.success} / 失败 ${summary.failed} / 共 ${summary.total}`);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
