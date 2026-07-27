export type WorkerType = "local" | "github-action";

export type AccountTaskSource = "due" | "manual";

export type AccountTaskStatus = "PENDING" | "RUNNING" | "SUCCESS" | "FAILED";

export interface AccountTaskOptions {
  limit?: number;
  categoryId?: number;
  zhName?: string;
}

export interface AccountTask {
  id: string;
  platform: string;
  accountId: string;
  source: AccountTaskSource;
  options: AccountTaskOptions;
  status: AccountTaskStatus;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  workerId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  resultSummary: Record<string, unknown> | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ClaimedAccountTask extends AccountTask {
  status: "RUNNING";
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface WorkerRegistration {
  workerId: string;
  workerType: WorkerType;
  status: "ACTIVE" | "OFFLINE";
  registeredAt: string;
  lastSeenAt: string;
}

export interface TaskPostResult {
  taskId: string;
  platform: string;
  accountId: string;
  postId: string;
  status: "success" | "failed";
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}
