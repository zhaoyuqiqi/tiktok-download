import type { DownloadResult, Summary, Task, Uploader } from "../types.ts";
import { TaskQueue } from "./task.ts";

export interface SchedulerOptions {
  workers: number;
  retry: number;
  retryDelayMs?: number;
}

export type DownloadFn = (task: Task) => Promise<DownloadResult>;

export async function runScheduler(
  queue: TaskQueue,
  options: SchedulerOptions,
  downloadFn: DownloadFn,
  uploader: Uploader,
): Promise<Summary> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const inflightUploads: Promise<void>[] = [];

  async function workerLoop(): Promise<void> {
    let task = queue.next();
    while (task !== undefined) {
      const result = await downloadFn(task);
      if (result.ok) {
        queue.markSuccess(task);
        if (result.filePath !== undefined) {
          const filePath = result.filePath;
          const p = uploader.upload(filePath).catch((err) => {
            console.error(`上传失败 ${filePath}:`, err);
          });
          inflightUploads.push(p);
        }
      } else if (task.attempts < options.retry) {
        await Bun.sleep(retryDelayMs);
        queue.requeue(task);
      } else {
        queue.markFailed(task);
      }
      task = queue.next();
    }
  }

  const loops = Array.from({ length: options.workers }, () => workerLoop());
  await Promise.all(loops);
  await Promise.allSettled(inflightUploads);

  return queue.summary();
}
