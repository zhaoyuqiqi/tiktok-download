import { randomUUID } from "node:crypto";
import { debugLog } from "../logging/debugLogger.ts";
import type {
  ClaimAccountTaskInput,
  CompleteAccountTaskInput,
  FailAccountTaskInput,
  TaskLeaseInput,
} from "../storage/repository.ts";
import type { ClaimedAccountTask, WorkerType } from "./protocol.ts";

export interface LocalWorkerRepository {
  registerWorker(
    workerId: string,
    workerType: WorkerType,
    nowIso: string,
  ): unknown;
  touchWorker(workerId: string, nowIso: string): boolean;
  finishWorker(workerId: string, nowIso: string): boolean;
  claimAccountTask(input: ClaimAccountTaskInput): ClaimedAccountTask | null;
  heartbeatAccountTask(
    input: TaskLeaseInput,
    leaseSeconds: number,
  ): unknown | null;
  completeAccountTask(input: CompleteAccountTaskInput): unknown | null;
  failAccountTask(input: FailAccountTaskInput): unknown | null;
}

export interface LocalWorkerDeps {
  repo: LocalWorkerRepository;
  concurrency: number;
  runTask: (task: ClaimedAccountTask) => Promise<Record<string, unknown>>;
  workerId?: string;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  now?: () => Date;
}

export class LocalWorker {
  readonly workerId: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly loops = new Set<Promise<void>>();

  constructor(private readonly deps: LocalWorkerDeps) {
    if (deps.concurrency <= 0) {
      throw new Error("local worker concurrency 必须为正数");
    }
    this.workerId = deps.workerId ?? `local-${process.pid}-${randomUUID()}`;
    this.leaseSeconds = deps.leaseSeconds ?? 300;
    this.heartbeatIntervalMs =
      deps.heartbeatIntervalMs ??
      Math.max(250, Math.min(30_000, (this.leaseSeconds * 1000) / 3));
  }

  get runningLoopCount(): number {
    return this.loops.size;
  }

  wake(): void {
    const nowIso = this.nowIso();
    this.deps.repo.registerWorker(this.workerId, "local", nowIso);

    while (this.loops.size < this.deps.concurrency) {
      const loop = this.drain();
      this.loops.add(loop);
      void loop
        .catch((error: unknown) => {
          debugLog("worker.local.loop_failed", {
            workerId: this.workerId,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.loops.delete(loop);
          if (this.loops.size === 0) {
            this.deps.repo.finishWorker(this.workerId, this.nowIso());
          }
        });
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.loops.size > 0) {
      await Promise.allSettled([...this.loops]);
    }
  }

  private async drain(): Promise<void> {
    while (true) {
      const task = this.deps.repo.claimAccountTask({
        workerId: this.workerId,
        nowIso: this.nowIso(),
        leaseSeconds: this.leaseSeconds,
        concurrency: this.deps.concurrency,
      });
      if (task === null) {
        return;
      }
      await this.executeTask(task);
    }
  }

  private async executeTask(task: ClaimedAccountTask): Promise<void> {
    debugLog("worker.local.task_start", {
      workerId: this.workerId,
      taskId: task.id,
      accountId: task.accountId,
      source: task.source,
    });

    let heartbeatInFlight = false;
    let leaseLost = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight || leaseLost) {
        return;
      }
      heartbeatInFlight = true;
      try {
        const renewed = this.deps.repo.heartbeatAccountTask(
          this.leaseInput(task),
          this.leaseSeconds,
        );
        leaseLost = renewed === null;
        this.deps.repo.touchWorker(this.workerId, this.nowIso());
      } finally {
        heartbeatInFlight = false;
      }
    }, this.heartbeatIntervalMs);

    try {
      const summary = await this.deps.runTask(task);
      if (leaseLost) {
        throw new Error("账号任务租约已失效，拒绝提交完成状态");
      }
      const completed = this.deps.repo.completeAccountTask({
        ...this.leaseInput(task),
        summary,
      });
      if (completed === null) {
        throw new Error("账号任务完成时租约校验失败");
      }
      debugLog("worker.local.task_success", {
        workerId: this.workerId,
        taskId: task.id,
        accountId: task.accountId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = this.deps.repo.failAccountTask({
        ...this.leaseInput(task),
        error: message,
      });
      debugLog("worker.local.task_failed", {
        workerId: this.workerId,
        taskId: task.id,
        accountId: task.accountId,
        statusRecorded: failed !== null,
        error: message,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private leaseInput(task: ClaimedAccountTask): TaskLeaseInput {
    return {
      taskId: task.id,
      workerId: this.workerId,
      leaseToken: task.leaseToken,
      nowIso: this.nowIso(),
    };
  }

  private nowIso(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
