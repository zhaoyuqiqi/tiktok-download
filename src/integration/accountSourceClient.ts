type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AccountSourceClientOptions {
  url: string;
  bearerToken?: string;
  fetchImpl?: FetchLike;
}

interface InstarAccountListPayload {
  code?: unknown;
  data?: {
    list?: unknown;
  };
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

    const payload = (await response.json()) as InstarAccountListPayload;

    if (payload === null || typeof payload !== "object") {
      throw new Error("账号名单返回格式无效，期望 { code:0, data:{ list:[{starId}] } }");
    }

    if (payload.code !== 0) {
      throw new Error(`账号名单返回 code 非 0: ${String(payload.code)}`);
    }

    const list = payload.data?.list;
    if (!Array.isArray(list)) {
      throw new Error("账号名单返回格式无效，期望 data.list 为数组");
    }

    const dedup = new Set<string>();
    for (const item of list) {
      if (typeof item !== "object" || item === null || !("starId" in item)) {
        throw new Error("账号名单返回格式无效，期望 list 元素包含 starId");
      }

      const rawStarId = (item as { starId?: string }).starId;
      if (typeof rawStarId !== "string") {
        throw new Error("账号名单返回格式无效，starId 必须是字符串");
      }

      const starId = rawStarId.trim();
      if (starId.length === 0) {
        throw new Error("账号名单返回格式无效，starId 不能为空");
      }

      dedup.add(starId);
    }

    return [...dedup];
  }
}
