import type { Readable } from "node:stream";

export interface VideoInfo {
  id: string;
  url: string; // 用于下载的页面 URL(entry.url ?? 由 id 兜底)
  title?: string; // flat-playlist 下可能缺失
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessStream {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
}

export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
  runStream(args: string[]): ProcessStream;
}

export interface Config {
  url: string;
  limit?: number; // 仅多视频生效
  workers: number; // 默认 2
  retry: number; // 默认 2
  outputDir: string; // 默认 ./output
  proxy?: string; // 透传给 yt-dlp --proxy,未指定则不传
}

