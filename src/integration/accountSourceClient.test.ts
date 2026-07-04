import { describe, expect, it } from "bun:test";
import { AccountSourceClient } from "./accountSourceClient.ts";

describe("AccountSourceClient", () => {
  it("支持 Bearer 鉴权并解析数组响应", async () => {
    let gotAuth = "";
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      bearerToken: "demo-token",
      fetchImpl: async (_url, init) => {
        gotAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        return new Response(JSON.stringify(["@alice", "@bob", "@alice", " "]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const accounts = await client.fetchAccounts();
    expect(gotAuth).toBe("Bearer demo-token");
    expect(accounts).toEqual(["@alice", "@bob"]);
  });

  it("支持 { accounts: string[] } 响应格式", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () =>
        new Response(JSON.stringify({ accounts: ["@a", "@b"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.fetchAccounts()).resolves.toEqual(["@a", "@b"]);
  });

  it("非 2xx 时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () => new Response("boom", { status: 500, statusText: "Internal Error" }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("账号名单拉取失败");
  });

  it("响应结构非法时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: ["@a"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("账号名单返回格式无效");
  });
});
