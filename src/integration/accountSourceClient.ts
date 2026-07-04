type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AccountSourceClientOptions {
  url: string;
  bearerToken?: string;
  fetchImpl?: FetchLike;
}

export class AccountSourceClient {
  private readonly url: string;
  private readonly bearerToken?: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: AccountSourceClientOptions) {
    this.url = options.url;
    this.bearerToken = options.bearerToken?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetchAccounts(): Promise<string[]> {
    const response = await this.fetchImpl(this.url, {
      headers:
        this.bearerToken !== undefined
          ? {
              Authorization: `Bearer ${this.bearerToken}`,
            }
          : undefined,
    });

    if (!response.ok) {
      throw new Error(`账号名单拉取失败: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as unknown;
    const rawAccounts = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && "accounts" in payload
        ? (payload as { accounts?: unknown }).accounts
        : null;

    if (!Array.isArray(rawAccounts)) {
      throw new Error("账号名单返回格式无效，期望 string[] 或 { accounts: string[] }");
    }

    const dedup = new Set<string>();
    for (const item of rawAccounts) {
      if (typeof item !== "string") {
        continue;
      }
      const accountId = item.trim();
      if (accountId.length === 0) {
        continue;
      }
      dedup.add(accountId);
    }

    return [...dedup];
  }
}
