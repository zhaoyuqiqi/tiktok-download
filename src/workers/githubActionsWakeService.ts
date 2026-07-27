import { debugLog } from "../logging/debugLogger.ts";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface GithubActionsWakeOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

interface WorkflowRun {
  id?: unknown;
  status?: unknown;
}

interface WorkflowRunsResponse {
  workflow_runs?: unknown;
}

const DEFAULT_OWNER = "zhaoyuqiqi";
const DEFAULT_REPO = "tiktok-download";
const DEFAULT_WORKFLOW_ID = "crawler-worker.yml";
const DEFAULT_REF = "main";
const ACTIVE_RUN_STATUSES = new Set([
  "requested",
  "waiting",
  "pending",
  "queued",
  "in_progress",
]);

function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback = "",
): string {
  return env[name]?.trim() || fallback;
}

function githubToken(env: NodeJS.ProcessEnv): string {
  return envValue(env, "APP_GITHUB_TOKEN") || envValue(env, "GITHUB_TOKEN");
}

export function assertGithubActionsWakeConfigured(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (githubToken(env).length === 0) {
    throw new Error(
      "GitHub Actions 唤醒失败: 请配置 GITHUB_TOKEN 或 APP_GITHUB_TOKEN",
    );
  }
}

function responseDetails(response: Response, body: string): string {
  const statusText = response.statusText.trim();
  const status = statusText.length > 0
    ? `${response.status} ${statusText}`
    : `${response.status}`;
  const trimmedBody = body.trim();
  return trimmedBody.length > 0 ? `${status}: ${trimmedBody}` : status;
}

async function readJsonResponse(
  response: Response,
  action: string,
): Promise<unknown> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${action}失败: ${responseDetails(response, body)}`);
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${action}失败: GitHub 返回了无效 JSON`);
  }
}

/**
 * 唤醒仓库中的 crawler workflow。
 *
 * Promise resolve 表示 workflow 已经存在活跃 run，或新的 workflow_dispatch
 * 已被 GitHub 接受。服务器环境必须提供 GITHUB_TOKEN（也支持
 * APP_GITHUB_TOKEN），仓库、workflow 和 ref 可通过 APP_GITHUB_* 变量覆盖。
 */
export async function wakeGithubActionsWorkflow(
  options: GithubActionsWakeOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  assertGithubActionsWakeConfigured(env);
  const token = githubToken(env);

  const owner = envValue(env, "APP_GITHUB_OWNER", DEFAULT_OWNER);
  const repo = envValue(env, "APP_GITHUB_REPO", DEFAULT_REPO);
  const workflowId = envValue(
    env,
    "APP_GITHUB_WORKFLOW_ID",
    DEFAULT_WORKFLOW_ID,
  );
  const ref = envValue(env, "APP_GITHUB_WORKFLOW_REF", DEFAULT_REF);
  const workflowUrl =
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}` +
    `/actions/workflows/${encodeURIComponent(workflowId)}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tiktok-downloader",
  };

  const runsResponse = await fetchImpl(`${workflowUrl}/runs?per_page=20`, {
    headers,
  });
  const runsPayload = await readJsonResponse(
    runsResponse,
    "查询 GitHub Actions workflow run",
  ) as WorkflowRunsResponse;
  const runs = runsPayload !== null && typeof runsPayload === "object"
    ? runsPayload.workflow_runs
    : undefined;

  if (!Array.isArray(runs)) {
    throw new Error(
      "查询 GitHub Actions workflow run 失败: 返回内容缺少 workflow_runs 数组",
    );
  }

  const activeRun = (runs as WorkflowRun[]).find(
    (run) => typeof run.status === "string" && ACTIVE_RUN_STATUSES.has(run.status),
  );
  if (activeRun !== undefined) {
    debugLog("worker.github_actions.wake_skipped", {
      reason: "active_run_exists",
      runId: activeRun.id,
      status: activeRun.status,
    });
    return;
  }

  const dispatchResponse = await fetchImpl(`${workflowUrl}/dispatches`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref }),
  });
  const dispatchBody = await dispatchResponse.text();
  if (!dispatchResponse.ok) {
    throw new Error(
      `触发 GitHub Actions workflow 失败: ${responseDetails(dispatchResponse, dispatchBody)}`,
    );
  }

  debugLog("worker.github_actions.dispatched", {
    owner,
    repo,
    workflowId,
    ref,
  });
}
