import { debugLog } from "../logging/debugLogger.ts";

export interface DueAccount {
  platform: string;
  accountId: string;
}

export interface ManualTriggerOptions {
  limit?: number;
}

export interface DueSchedulerDeps {
  concurrency: number;
  listDueAccounts: (limit: number) => Promise<DueAccount[]>;
  runAccount: (accountId: string, source: "due" | "manual", options?: ManualTriggerOptions) => Promise<void>;
  maxAttempts?: number;
  backoffMs?: number[];
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timerId: ReturnType<typeof setTimeout>) => void;
}

const DEFAULT_BACKOFF_MS = [60_000, 180_000, 600_000] as const;

export class DueScheduler {
  private readonly runningAccounts = new Set<string>();
  private readonly queuedManualAccounts: string[] = [];
  private readonly queuedManualSet = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failedAttempts = new Map<string, number>();
  private readonly manualOptions = new Map<string, ManualTriggerOptions>();

  constructor(private readonly deps: DueSchedulerDeps) {}

  get runningCount(): number {
    return this.runningAccounts.size;
  }

  async tick(): Promise<void> {
    debugLog("scheduler.tick.start", {
      runningCount: this.runningAccounts.size,
      queuedManualCount: this.queuedManualAccounts.length,
      retryingCount: this.retryTimers.size,
      concurrency: this.deps.concurrency,
    });

    this.drainManualQueue();

    const remaining = Math.max(0, this.deps.concurrency - this.runningAccounts.size);
    if (remaining === 0) {
      debugLog("scheduler.tick.skip_no_capacity", {
        runningCount: this.runningAccounts.size,
        concurrency: this.deps.concurrency,
      });
      return;
    }

    const dueAccounts = await this.deps.listDueAccounts(remaining);
    debugLog("scheduler.tick.due_loaded", {
      requestedLimit: remaining,
      dueCount: dueAccounts.length,
    });

    for (const account of dueAccounts) {
      if (this.runningAccounts.size >= this.deps.concurrency) {
        break;
      }
      if (this.runningAccounts.has(account.accountId)) {
        continue;
      }
      if (this.queuedManualSet.has(account.accountId)) {
        continue;
      }
      if (this.retryTimers.has(account.accountId)) {
        continue;
      }

      this.start(account.accountId, "due");
    }
  }

  async trigger(accountId: string, options?: ManualTriggerOptions): Promise<void> {
    debugLog("scheduler.trigger.requested", {
      accountId,
      limit: options?.limit ?? null,
      runningCount: this.runningAccounts.size,
      queuedManualCount: this.queuedManualAccounts.length,
      concurrency: this.deps.concurrency,
    });

    this.cancelRetry(accountId);

    if (this.runningAccounts.has(accountId) || this.queuedManualSet.has(accountId)) {
      debugLog("scheduler.trigger.ignored_duplicate", { accountId });
      return;
    }

    this.manualOptions.set(accountId, options ?? {});

    if (this.runningAccounts.size >= this.deps.concurrency) {
      this.enqueueManual(accountId);
      return;
    }

    this.start(accountId, "manual");
  }

  private enqueueManual(accountId: string): void {
    if (this.queuedManualSet.has(accountId)) {
      return;
    }
    this.queuedManualSet.add(accountId);
    this.queuedManualAccounts.push(accountId);

    debugLog("scheduler.manual.enqueued", {
      accountId,
      queuedManualCount: this.queuedManualAccounts.length,
    });
  }

  private drainManualQueue(): void {
    while (this.runningAccounts.size < this.deps.concurrency && this.queuedManualAccounts.length > 0) {
      const accountId = this.queuedManualAccounts.shift();
      if (accountId === undefined) {
        return;
      }
      this.queuedManualSet.delete(accountId);

      if (this.runningAccounts.has(accountId) || this.retryTimers.has(accountId)) {
        continue;
      }

      debugLog("scheduler.manual.dequeue", {
        accountId,
        runningCount: this.runningAccounts.size,
        queuedManualCount: this.queuedManualAccounts.length,
      });
      this.start(accountId, "manual");
    }
  }

  private cancelRetry(accountId: string): void {
    const timer = this.retryTimers.get(accountId);
    if (timer === undefined) {
      return;
    }

    if (this.deps.clearTimer) {
      this.deps.clearTimer(timer);
    } else {
      clearTimeout(timer as unknown as number);
    }
    this.retryTimers.delete(accountId);

    debugLog("scheduler.retry.canceled", { accountId });
  }

  private scheduleRetry(accountId: string, source: "due" | "manual", attempt: number): void {
    const maxAttempts = this.deps.maxAttempts ?? 3;
    if (attempt > maxAttempts) {
      this.failedAttempts.delete(accountId);
      this.cancelRetry(accountId);
      if (source === "manual") {
        this.manualOptions.delete(accountId);
      }
      debugLog("scheduler.retry.give_up", {
        accountId,
        source,
        attempt,
        maxAttempts,
      });
      return;
    }

    const backoffMs = this.deps.backoffMs ?? [...DEFAULT_BACKOFF_MS];
    const index = Math.min(attempt - 1, backoffMs.length - 1);
    const delay = backoffMs[index] ?? backoffMs[backoffMs.length - 1] ?? 0;

    this.cancelRetry(accountId);
    debugLog("scheduler.retry.scheduled", {
      accountId,
      source,
      attempt,
      delayMs: delay,
    });

    const timer = this.deps.setTimer
      ? this.deps.setTimer(() => {
          this.retryTimers.delete(accountId);
          debugLog("scheduler.retry.fire", {
            accountId,
            source,
            attempt,
          });
          this.start(accountId, source);
        }, delay)
      : setTimeout(() => {
          this.retryTimers.delete(accountId);
          debugLog("scheduler.retry.fire", {
            accountId,
            source,
            attempt,
          });
          this.start(accountId, source);
        }, delay);
    this.retryTimers.set(accountId, timer);
  }

  private start(accountId: string, source: "due" | "manual"): void {
    if (this.runningAccounts.has(accountId)) {
      return;
    }

    const options = source === "manual" ? this.manualOptions.get(accountId) : undefined;

    this.runningAccounts.add(accountId);
    debugLog("scheduler.account.start", {
      accountId,
      source,
      limit: options?.limit ?? null,
      runningCount: this.runningAccounts.size,
      concurrency: this.deps.concurrency,
    });

    Promise.resolve()
      .then(() => this.deps.runAccount(accountId, source, options))
      .then(() => {
        this.failedAttempts.delete(accountId);
        this.cancelRetry(accountId);
        if (source === "manual") {
          this.manualOptions.delete(accountId);
        }
        debugLog("scheduler.account.success", {
          accountId,
          source,
        });
      })
      .catch((error: unknown) => {
        const attempt = (this.failedAttempts.get(accountId) ?? 0) + 1;
        this.failedAttempts.set(accountId, attempt);
        debugLog("scheduler.account.failed", {
          accountId,
          source,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleRetry(accountId, source, attempt);
      })
      .finally(() => {
        this.runningAccounts.delete(accountId);
        debugLog("scheduler.account.finish", {
          accountId,
          source,
          runningCount: this.runningAccounts.size,
        });
        this.drainManualQueue();
      });
  }
}
