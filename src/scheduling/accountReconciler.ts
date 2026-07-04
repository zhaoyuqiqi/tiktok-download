import type { StateRepository } from "../storage/repository.ts";

export interface ReconcileOptions {
  platform: string;
  accountIds: string[];
  jitterRangeMs?: [number, number];
  now?: () => Date;
  random?: () => number;
}

export interface ReconcileResult {
  totalExternal: number;
  added: number;
  reactivated: number;
  deactivated: number;
}

function uniqueNormalizedAccountIds(input: string[]): string[] {
  const set = new Set<string>();
  for (const raw of input) {
    const accountId = raw.trim();
    if (accountId.length === 0) {
      continue;
    }
    set.add(accountId);
  }
  return [...set];
}

function pickJitterMs(range: [number, number], random: () => number): number {
  const [min, max] = range;
  if (max <= min) {
    return min;
  }
  return Math.floor(min + random() * (max - min));
}

export function reconcileAccounts(
  repo: StateRepository,
  options: ReconcileOptions,
): ReconcileResult {
  const now = options.now ?? (() => new Date());
  const random = options.random ?? Math.random;
  const jitterRangeMs = options.jitterRangeMs ?? [0, 60_000];

  const externalAccountIds = uniqueNormalizedAccountIds(options.accountIds);
  const externalSet = new Set(externalAccountIds);

  const localAccounts = repo.listAccounts(options.platform, 100_000);
  const localById = new Map(localAccounts.map((item) => [item.accountId, item]));

  let added = 0;
  let reactivated = 0;
  let deactivated = 0;

  for (const accountId of externalAccountIds) {
    const existed = localById.get(accountId);

    if (existed === undefined) {
      const jitterMs = pickJitterMs(jitterRangeMs, random);
      const nextRunAt = new Date(now().getTime() + jitterMs).toISOString();
      repo.upsertAccount({
        platform: options.platform,
        accountId,
        nextRunAt,
        active: true,
      });
      added += 1;
      continue;
    }

    if (!existed.active) {
      repo.setAccountActive(options.platform, accountId, true);
      reactivated += 1;
    }
  }

  for (const account of localAccounts) {
    if (!externalSet.has(account.accountId) && account.active) {
      repo.setAccountActive(options.platform, account.accountId, false);
      deactivated += 1;
    }
  }

  return {
    totalExternal: externalAccountIds.length,
    added,
    reactivated,
    deactivated,
  };
}
