import { debugLog } from "../logging/debugLogger.ts";

export interface DueAccount {
  platform: string;
  accountId: string;
}

export interface ManualTriggerOptions {
  limit?: number;
  categoryId?: number;
  zhName?: string;
}

export interface DueSchedulerDeps {
  discoveryLimit?: number;
  listDueAccounts: (limit: number, nowIso: string) => Promise<DueAccount[]>;
  enqueueAccountTask: (
    accountId: string,
    source: "due" | "manual",
    options: ManualTriggerOptions | undefined,
    nowIso: string,
  ) => Promise<{ created: boolean }>;
  recoverTasks: (nowIso: string) => Promise<number> | number;
  countClaimableTasks: () => Promise<number> | number;
  countRunningTasks: () => number;
  wakeWorkers: () => Promise<void> | void;
  now?: () => Date;
}

export class DueScheduler {
  constructor(private readonly deps: DueSchedulerDeps) {}

  get runningCount(): number {
    return this.deps.countRunningTasks();
  }

  async tick(): Promise<void> {
    const nowIso = (this.deps.now?.() ?? new Date()).toISOString();
    const recoveredCount = await this.deps.recoverTasks(nowIso);
    const discoveryLimit = this.deps.discoveryLimit ?? 100;

    debugLog("scheduler.tick.start", {
      runningCount: this.runningCount,
      recoveredCount,
      discoveryLimit,
    });

    const dueAccounts = await this.deps.listDueAccounts(discoveryLimit, nowIso);
    let createdCount = 0;
    for (const account of dueAccounts) {
      const result = await this.deps.enqueueAccountTask(
        account.accountId,
        "due",
        undefined,
        nowIso,
      );
      if (result.created) {
        createdCount += 1;
      }
    }

    const claimableCount = await this.deps.countClaimableTasks();
    debugLog("scheduler.tick.due_enqueued", {
      dueCount: dueAccounts.length,
      createdCount,
      claimableCount,
      recoveredCount,
    });

    if (claimableCount > 0) {
      await this.tryWakeWorkers();
    }
  }

  async trigger(
    accountId: string,
    options?: ManualTriggerOptions,
  ): Promise<void> {
    const nowIso = (this.deps.now?.() ?? new Date()).toISOString();
    debugLog("scheduler.trigger.requested", {
      accountId,
      limit: options?.limit ?? null,
      categoryId: options?.categoryId ?? null,
      zhName: options?.zhName ?? null,
      runningCount: this.runningCount,
    });

    const result = await this.deps.enqueueAccountTask(
      accountId,
      "manual",
      options,
      nowIso,
    );
    debugLog("scheduler.trigger.enqueued", {
      accountId,
      created: result.created,
    });
    const claimableCount = await this.deps.countClaimableTasks();
    if (result.created || claimableCount > 0) {
      await this.tryWakeWorkers();
    }
  }

  private async tryWakeWorkers(): Promise<void> {
    try {
      await this.deps.wakeWorkers();
    } catch (error) {
      debugLog("scheduler.worker_wake.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
