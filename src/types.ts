export type TaskStatus = "pending" | "running" | "success" | "failed";

export interface VideoInfo {
  id: string;
  url: string; // 用于下载的页面 URL(entry.url ?? 由 id 兜底)
  title?: string; // flat-playlist 下可能缺失
}

export interface Task {
  id: string;
  url: string;
  title?: string;
  status: TaskStatus;
  attempts: number; // 已尝试次数
}

export interface Uploader {
  upload(filePath: string): Promise<void>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
}

export interface Config {
  url: string;
  limit?: number; // 仅多视频生效
  workers: number; // 默认 2
  retry: number; // 默认 2
  outputDir: string; // 默认 ./output
  proxy?: string; // 透传给 yt-dlp --proxy,未指定则不传
}

export interface DownloadResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

export interface Summary {
  success: number;
  failed: number;
  total: number;
}
