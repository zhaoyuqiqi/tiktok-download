import type { Summary, Task, VideoInfo } from "./types.ts";

export function createTask(video: VideoInfo): Task {
  return {
    id: video.id,
    url: video.url,
    title: video.title,
    status: "pending",
    attempts: 0,
  };
}

export class TaskQueue {
  constructor(private readonly tasks: Task[]) {}

  next(): Task | undefined {
    const task = this.tasks.find((t) => t.status === "pending");
    if (task) {
      task.status = "running";
    }
    return task;
  }

  markSuccess(task: Task): void {
    task.status = "success";
  }

  markFailed(task: Task): void {
    task.status = "failed";
  }

  requeue(task: Task): void {
    task.attempts += 1;
    task.status = "pending";
  }

  summary(): Summary {
    let success = 0;
    let failed = 0;
    for (const t of this.tasks) {
      if (t.status === "success") success += 1;
      else if (t.status === "failed") failed += 1;
    }
    return { success, failed, total: this.tasks.length };
  }
}
