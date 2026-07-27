import { describe, expect, it } from "bun:test";
import { wakeGithubActionsWorkflow } from "./githubActionsWakeService.ts";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

const baseEnv = {
  GITHUB_TOKEN: "github-token",
  APP_GITHUB_OWNER: "demo-owner",
  APP_GITHUB_REPO: "demo-repo",
  APP_GITHUB_WORKFLOW_ID: "worker.yml",
  APP_GITHUB_WORKFLOW_REF: "release",
};

describe("wakeGithubActionsWorkflow", () => {
  it("没有活跃 run 时触发 workflow_dispatch", async () => {
    const calls: FetchCall[] = [];
    const responses = [
      new Response(
        JSON.stringify({ workflow_runs: [{ id: 99, status: "completed" }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
      new Response(null, { status: 204 }),
    ];

    await wakeGithubActionsWorkflow({
      env: baseEnv,
      async fetchImpl(input, init) {
        calls.push({ url: String(input), init });
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("unexpected fetch");
        }
        return response;
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(
      "https://api.github.com/repos/demo-owner/demo-repo/actions/workflows/worker.yml/runs?per_page=20",
    );
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/demo-owner/demo-repo/actions/workflows/worker.yml/dispatches",
    );
    expect(calls[1]?.init?.method).toBe("POST");
    expect(calls[1]?.init?.body).toBe(JSON.stringify({ ref: "release" }));

    const headers = calls[1]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer github-token");
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("存在 queued 或 in_progress run 时不重复 dispatch", async () => {
    let fetchCount = 0;

    await wakeGithubActionsWorkflow({
      env: baseEnv,
      async fetchImpl() {
        fetchCount += 1;
        return new Response(
          JSON.stringify({
            workflow_runs: [{ id: 123, status: "queued" }],
          }),
          { status: 200 },
        );
      },
    });

    expect(fetchCount).toBe(1);
  });

  it("未配置 token 时在发请求前报错", async () => {
    let fetchCalled = false;

    await expect(
      wakeGithubActionsWorkflow({
        env: {},
        async fetchImpl() {
          fetchCalled = true;
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow("GITHUB_TOKEN");
    expect(fetchCalled).toBe(false);
  });

  it("查询 run 失败时包含 GitHub 响应信息", async () => {
    await expect(
      wakeGithubActionsWorkflow({
        env: baseEnv,
        async fetchImpl() {
          return new Response('{"message":"Bad credentials"}', {
            status: 401,
            statusText: "Unauthorized",
          });
        },
      }),
    ).rejects.toThrow('401 Unauthorized: {"message":"Bad credentials"}');
  });

  it("dispatch 失败时包含 GitHub 响应信息", async () => {
    const responses = [
      new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 }),
      new Response('{"message":"Not Found"}', {
        status: 404,
        statusText: "Not Found",
      }),
    ];

    await expect(
      wakeGithubActionsWorkflow({
        env: baseEnv,
        async fetchImpl() {
          const response = responses.shift();
          if (response === undefined) {
            throw new Error("unexpected fetch");
          }
          return response;
        },
      }),
    ).rejects.toThrow('404 Not Found: {"message":"Not Found"}');
  });
});
