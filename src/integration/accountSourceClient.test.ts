import { describe, expect, it } from "bun:test";
import { AccountSourceClient } from "./accountSourceClient.ts";

describe("AccountSourceClient", () => {
  it("支持 Bearer 鉴权并解析 instar 协议", async () => {
    let gotAuth = "";
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      bearerToken: "demo-token",
      fetchImpl: async (_url, init) => {
        gotAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              list: [{ starId: "@alice" }, { starId: "@bob" }, { starId: "@alice" }],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    });

    const accounts = await client.fetchAccounts();
    expect(gotAuth).toBe("Bearer demo-token");
    expect(accounts).toEqual(["@alice", "@bob"]);
  });

  it("code 非 0 时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 1001, data: { list: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("code 非 0");
  });

  it("starId 为空字符串时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 0, data: { list: [{ starId: "  " }] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("starId 不能为空");
  });

  it("非 2xx 时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () => new Response("boom", { status: 500, statusText: "Internal Error" }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("账号名单拉取失败");
  });

  it("结构非法时抛错", async () => {
    const client = new AccountSourceClient({
      url: "https://example.com/accounts",
      fetchImpl: async () =>
        new Response(JSON.stringify({ code: 0, data: { accounts: ["@a"] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });

    await expect(client.fetchAccounts()).rejects.toThrow("data.list");
  });
});
