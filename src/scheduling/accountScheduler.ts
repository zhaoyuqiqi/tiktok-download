export interface AccountJob {
  id: string;
  accountId: string;
  execute: () => Promise<void>;
}

export interface AccountSchedulerOptions {
  concurrency?: number;
  maxAttempts?: number;
  backoffMs?: number[];
  prefetchDelayRangeMs?: [number, number];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  tickMs?: number;
}

export interface AccountSchedulerSummary {
  total: number;
  success: number;
  failed: number;
}

interface QueueItem {
  job: AccountJob;
  attempts: number;
  nextRunAt: number;
}

const DEFAULT_BACKOFF = [60_000, 180_000, 600_000] as const;

function chooseDelay(range: [number, number], random: () => number): number {
  const [min, max] = range;
  if (max <= min) {
    return min;
  }
  return Math.floor(min + random() * (max - min));
}

export async function runAccountScheduler(
  jobs: AccountJob[],
  options: AccountSchedulerOptions = {},
): Promise<AccountSchedulerSummary> {
  const concurrency = options.concurrency ?? 2;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? [...DEFAULT_BACKOFF];
  const prefetchDelayRangeMs = options.prefetchDelayRangeMs ?? [2_000, 8_000];
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const tickMs = options.tickMs ?? 200;

  const queue: QueueItem[] = jobs.map((job) => ({
    job,
    attempts: 0,
    nextRunAt: now(),
  }));

  const activeAccounts = new Set<string>();
  const running = new Set<Promise<void>>();
  let success = 0;
  let failed = 0;

  async function launch(item: QueueItem): Promise<void> {
    activeAccounts.add(item.job.accountId);

    try {
      const jitter = chooseDelay(prefetchDelayRangeMs, random);
      await sleep(jitter);
      await item.job.execute();
      success += 1;
      queue.splice(queue.indexOf(item), 1);
    } catch {
      item.attempts += 1;
      if (item.attempts > maxAttempts) {
        failed += 1;
        queue.splice(queue.indexOf(item), 1);
      } else {
        const backoffIndex = Math.min(item.attempts - 1, backoffMs.length - 1);
        const delay = backoffMs[backoffIndex] ?? backoffMs[backoffMs.length - 1] ?? 0;
        item.nextRunAt = now() + delay;
      }
    } finally {
      activeAccounts.delete(item.job.accountId);
    }
  }

  while (queue.length > 0 || running.size > 0) {
    const current = now();
    let launched = false;

    for (const item of queue) {
      if (running.size >= concurrency) {
        break;
      }
      if (item.nextRunAt > current) {
        continue;
      }
      if (activeAccounts.has(item.job.accountId)) {
        continue;
      }

      launched = true;
      const p = launch(item).finally(() => {
        running.delete(p);
      });
      running.add(p);
    }

    if (!launched) {
      await sleep(tickMs);
    }
  }

  return {
    total: jobs.length,
    success,
    failed,
  };
}
