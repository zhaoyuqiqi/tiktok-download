---
change: serve-tiktok-download-worker
design-doc: docs/superpowers/specs/2026-07-03-serve-tiktok-download-worker-design.md
base-ref: e6e9998a62c42f5e5981a2866410513a96be0131
archived-with: 2026-07-04-serve-tiktok-download-worker
---

# TikTok 下载服务化改造 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 将一次性 CLI 下载器重构为常驻 Elysia Web 服务:due 驱动调度、SQLite 最小状态持久化、平台适配器解耦、并发/串行/退避控制、COS 流式上传、instar 回传预留。

**Architecture:** 平台无关公共层(Scheduler / FetchPipeline / Store / Uploader / CallbackSink / Reconciler / HTTP / Clock / Config)承载调度、持久化、并发、退避、去重、上传、回传;平台差异全部下沉到 `PlatformAdapter` 抽象,由 `TikTokAdapter`(基于既有 `YtDlpRunner`)实现。所有外部边界通过构造函数注入,便于 TDD 与多平台扩展。

**Tech Stack:** Bun + TypeScript、Elysia(HTTP)、`bun:sqlite`(WAL)、`cos-nodejs-sdk-v5`(COS 流式 putObject)、既有 `src/ytdlp-manager/runner.ts` 的 `YtDlpRunner`(实现 `ProcessRunner`)。测试用 `bun test`。

## Global Constraints

以下为项目级约束,每个任务隐含包含本节。所有值以 Design Doc 为权威:

- **运行时:** 一律用 Bun,不用 Node。测试用 `bun test`;SQLite 用 `bun:sqlite`,不用 `better-sqlite3`;文件读写优先 `Bun.file`。COS 仍用 `cos-nodejs-sdk-v5`(SDK 需要 Node 流)。
- **测试铁律:** 不碰真实网络 / 不启动真实 yt-dlp 进程。时间驱动逻辑一律用可注入 `Clock`(手动推进),不真 `sleep`。SQLite 测试用 `:memory:` 或临时文件真实建库。
- **可注入接缝(构造函数注入):** `ProcessRunner`、`PlatformAdapter`、`Uploader`、`CallbackSink`、`AccountListSource`、`Clock`、`Store`(封装 SQLite 连接)。
- **平台解耦:** 调度、并发、退避、去重、COS 上传、回传等公共逻辑 SHALL NOT 依赖任何平台特有细节(如 yt-dlp 命令),只依赖 `PlatformAdapter` 接口与标准化 `Post` 结构。
- **SQLite 最小状态:** 只存 `accounts` 与 `fetched_posts` 两表的调度/去重必需字段。SHALL NOT 存 title、作者、媒体 URL、清洗后 payload、COS key。
- **时间单位:** 所有持久化时间戳为 epoch 毫秒(`number`)。
- **测试文件命名:** 与被测文件同目录同名 `.test.ts`(遵循现有 `src/**/x.test.ts` 约定)。测试用例名用中文,fake 依赖用手写对象/类(参考 `src/parsing/parser.test.ts`、`src/scheduling/scheduler.test.ts`)。
- **默认配置值:** `GLOBAL_CONCURRENCY=2`、`SCHEDULE_TICK_INTERVAL=60s`、`RECONCILE_INTERVAL=5min`、`LEASE_BASELINE=5min`、`LEASE_HEARTBEAT=2min`、`FETCH_DELAY_MIN=2s`/`MAX=8s`、`POST_TIMEOUT=5min`、`RETRY_BACKOFF=[1m,3m,10m]`、`RETRY_MAX=3`、`ACTIVE_MIN_INTERVAL=30min`、`IDLE_INTERVAL=6h`、`IDLE_THRESHOLD=24h`、`ACTIVE_MAX_POSTS=100`。
- **每个 task 结束即提交:** 通过 TDD(先写失败测试→跑失败→最小实现→跑通过→commit)。commit message 用 conventional commits(`feat:` / `test:` / `chore:` / `refactor:`)。

## 依赖顺序总览

任务按依赖自底向上:先纯函数/类型/时钟 → Store(SQLite) → 平台适配器 → 流水线组件(COS key / 上传 / 回传 / pipeline) → 调度引擎(并发 / 退避 / due / 自适应 / 主动) → reconcile → HTTP 服务 → 移除 CLI 与部署文档。

| Task | 交付物 | 覆盖 tasks.md | 覆盖 spec |
|---|---|---|---|
| 1 | 依赖引入 + Elysia 服务骨架空壳 | 1.1 | tiktok-fetch-service:Elysia 常驻 |
| 2 | Config(环境变量解析) | 1.2 | 可配置抓取周期 |
| 3 | Clock 抽象 | 测试策略接缝 | 时间驱动可测 |
| 4 | 标准化 Post 类型 + PlatformAdapter 接口 | 3.1 | 平台适配器抽象 / 数据清洗 |
| 5 | Store:schema + 建库 | 2.1 | SQLite 持久化 |
| 6 | Store:去重读写 + 游标 | 2.2 | 成功不重复 / 重启保留 |
| 7 | Store:lease 领取事务 + 心跳 | 5.1(占用) | 账号占用防重复领取 / 崩溃重领 |
| 8 | Store:reconcile upsert/inactive | 5.5 | 外部账号名单对账 |
| 9 | Store:退避帖子读写 + due 帖子挑选 | 5.2 | 失败重试与退避 |
| 10 | TikTokAdapter:listPosts | 3.2 | 列表与详情两段抓取 |
| 11 | TikTokAdapter:fetchDetail + cleanse(发布时间降级) | 3.2 | 按发布时间 / 缺失估算 |
| 12 | TikTokAdapter:openMediaStream | 3.2 | 视频流直传 |
| 13 | COS key 纯函数 | 4.3 | 默认 COS key 命名 |
| 14 | CosUploader:流式 putObject + abort | 4.4 | 流式上传 / 超时中止 |
| 15 | CallbackSink 接口 + 预留实现 | 4.5 | 成功后回传适配层 |
| 16 | 随机延迟工具(Clock 可测) | 5.3 | yt-dlp 调用随机延迟 |
| 17 | FetchPipeline:过滤 + 排序 + 100 条上限 | 4.1/4.2/5.7 | 仅抓新帖 / 升序 / 100 条 |
| 18 | FetchPipeline:逐帖处理 + 超时 + 退避 + 回传 + 去重写入 | 4.4/5.2 | 流式上传 / 退避 / 回滚 |
| 19 | 自适应 next_run_at 纯函数 | 5.6 | 活跃度自适应频率 |
| 20 | Scheduler:并发信号量 + due tick + lease 心跳 + 自适应回写 | 5.1/5.4/5.6 | 并发 / due / 同账号串行 |
| 21 | Scheduler:退避帖子重拉旁路 | 5.2 | 退避释放额度后重拉 |
| 22 | AccountListSource + Reconciler 循环 | 5.5/6.3 | 名单对账不触发抓取 |
| 23 | HTTP:POST /fetch(异步 202 + 即时插入) | 6.1/5.7 | 主动触发异步受理 / 本地不存在 |
| 24 | HTTP:GET /status + GET /health | 6.2 | 状态查询 |
| 25 | 服务装配 + 启动 tick/reconcile 循环 | 1.1 | 常驻服务运行 |
| 26 | 移除 CLI 主入口及废弃模块 | 7(收尾) | REMOVED:解析列表/代理/worker池 |
| 27 | 补全关键场景集成测试 | 7.1 | 全部验收场景回归 |
| 28 | 更新 README/部署说明(挂载 volume) | 7.2 | 重启保留(Docker) |

archived-with: 2026-07-04-serve-tiktok-download-worker
---

## File Structure

新增(全部在 `src/` 下,按职责分目录):

- `src/config.ts` — 环境变量解析与默认值(`loadConfig`)。
- `src/clock.ts` — `Clock` 接口 + `SystemClock` + `ManualClock`(测试用)。
- `src/platform/adapter.ts` — `Post` 标准化结构 + `PlatformAdapter` 接口。
- `src/platform/tiktok/adapter.ts` — `TikTokAdapter`(基于 `ProcessRunner`)。
- `src/store/schema.ts` — SQLite DDL 常量。
- `src/store/store.ts` — `Store` 类(封装 `bun:sqlite` 连接,所有读写/事务)。
- `src/pipeline/cosKey.ts` — COS key 纯函数。
- `src/pipeline/uploader.ts` — `CosUploader`(替换/扩展现有 `Uploader` 语义为流式)。
- `src/pipeline/callbackSink.ts` — `CallbackSink` 接口 + `NoopCallbackSink`。
- `src/pipeline/delay.ts` — 随机延迟工具。
- `src/pipeline/pipeline.ts` — `FetchPipeline`。
- `src/pipeline/nextRun.ts` — 自适应 `next_run_at` 纯函数。
- `src/scheduler/scheduler.ts` — `Scheduler`(并发/串行/due/退避/自适应)。
- `src/accounts/listSource.ts` — `AccountListSource` 接口 + HTTP 实现。
- `src/accounts/reconciler.ts` — `Reconciler`。
- `src/server.ts` — Elysia app 装配(路由 + 启动循环)。
- `src/index.ts` — **重写**为服务入口(替换 CLI)。
- `src/types.ts` — **修改**:扩展/清理类型(保留 `ProcessRunner`/`ProcessResult`/`ProcessStream`,新增服务侧类型,移除 CLI 专用 `Config`)。

移除(Task 26):`src/parsing/`、`src/scheduling/`、`src/ytdlp-manager/worker.ts`、`src/upload/uploader.ts`(旧 Noop)、`src/cli.test.ts`、CLI 版 `parseArgs`/`main`。

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 1: 引入依赖并搭建 Elysia 服务空壳

**Files:**
- Modify: `package.json`(dependencies)
- Create: `src/server.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `createServer(deps: ServerDeps): Elysia` —— 本任务仅产出最小空壳,`ServerDeps` 暂为空对象 `{}`;返回的 app 提供 `GET /health` 返回 `{ ok: true }`。后续 Task 23/24/25 扩展路由与依赖。

- [x] **Step 1: 安装依赖**

Run: `bun add elysia`
Expected: `package.json` 的 `dependencies` 出现 `elysia`(`cos-nodejs-sdk-v5` 已存在,无需再装)。

- [x] **Step 2: 写失败测试**

```ts
// src/server.test.ts
import { test, expect } from "bun:test";
import { createServer } from "./server.ts";

test("GET /health 返回 ok", async () => {
  const app = createServer({});
  const res = await app.handle(new Request("http://localhost/health"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `bun test src/server.test.ts`
Expected: FAIL(`Cannot find module './server.ts'`)。

- [x] **Step 4: 最小实现**

```ts
// src/server.ts
import { Elysia } from "elysia";

export interface ServerDeps {}

export function createServer(_deps: ServerDeps): Elysia {
  return new Elysia().get("/health", () => ({ ok: true }));
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `bun test src/server.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add package.json bun.lock src/server.ts src/server.test.ts
git commit -m "feat: scaffold elysia server shell with health endpoint"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 2: Config 环境变量解析

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface AppConfig {
    globalConcurrency: number;      // GLOBAL_CONCURRENCY 默认 2
    scheduleTickMs: number;         // SCHEDULE_TICK_INTERVAL 默认 60_000
    reconcileMs: number;            // RECONCILE_INTERVAL 默认 300_000
    leaseBaselineMs: number;        // LEASE_BASELINE 默认 300_000
    leaseHeartbeatMs: number;       // LEASE_HEARTBEAT 默认 120_000
    fetchDelayMinMs: number;        // FETCH_DELAY_MIN 默认 2_000
    fetchDelayMaxMs: number;        // FETCH_DELAY_MAX 默认 8_000
    postTimeoutMs: number;          // POST_TIMEOUT 默认 300_000
    retryBackoffMs: number[];       // RETRY_BACKOFF 默认 [60_000,180_000,600_000]
    retryMax: number;               // RETRY_MAX 默认 3
    activeMinIntervalMs: number;    // ACTIVE_MIN_INTERVAL 默认 1_800_000
    idleIntervalMs: number;         // IDLE_INTERVAL 默认 21_600_000
    idleThresholdMs: number;        // IDLE_THRESHOLD 默认 86_400_000
    activeMaxPosts: number;         // ACTIVE_MAX_POSTS 默认 100
    accountListUrl: string;         // ACCOUNT_LIST_URL 必填(缺失抛错)
    cos: { bucket: string; region: string; secretId: string; secretKey: string }; // COS_* 必填
    sqlitePath: string;             // SQLITE_PATH 默认 "./data/worker.sqlite"
    proxy?: string;                 // YT_DLP_PROXY 可选
    instarCallbackUrl?: string;     // INSTAR_CALLBACK_URL 可选
  }
  export function loadConfig(env: Record<string, string | undefined>): AppConfig;
  ```
  `loadConfig` 接收 env 对象(便于测试注入),不直接读 `process.env`。缺失必填项抛 `Error`。

- [x] **Step 1: 写失败测试**

```ts
// src/config.test.ts
import { test, expect } from "bun:test";
import { loadConfig } from "./config.ts";

const base = {
  ACCOUNT_LIST_URL: "http://list.local/accounts",
  COS_BUCKET: "b-1250000000",
  COS_REGION: "ap-beijing",
  COS_SECRET_ID: "id",
  COS_SECRET_KEY: "key",
};

test("缺省值正确", () => {
  const c = loadConfig(base);
  expect(c.globalConcurrency).toBe(2);
  expect(c.reconcileMs).toBe(300_000);
  expect(c.retryBackoffMs).toEqual([60_000, 180_000, 600_000]);
  expect(c.retryMax).toBe(3);
  expect(c.activeMaxPosts).toBe(100);
  expect(c.sqlitePath).toBe("./data/worker.sqlite");
});

test("环境变量覆盖默认", () => {
  const c = loadConfig({ ...base, GLOBAL_CONCURRENCY: "5", SQLITE_PATH: "/data/x.db" });
  expect(c.globalConcurrency).toBe(5);
  expect(c.sqlitePath).toBe("/data/x.db");
});

test("缺 ACCOUNT_LIST_URL 抛错", () => {
  const { ACCOUNT_LIST_URL, ...rest } = base;
  expect(() => loadConfig(rest)).toThrow(/ACCOUNT_LIST_URL/);
});

test("缺 COS 必填抛错", () => {
  const { COS_BUCKET, ...rest } = base;
  expect(() => loadConfig(rest)).toThrow(/COS_BUCKET/);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/config.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/config.ts
export interface AppConfig {
  globalConcurrency: number;
  scheduleTickMs: number;
  reconcileMs: number;
  leaseBaselineMs: number;
  leaseHeartbeatMs: number;
  fetchDelayMinMs: number;
  fetchDelayMaxMs: number;
  postTimeoutMs: number;
  retryBackoffMs: number[];
  retryMax: number;
  activeMinIntervalMs: number;
  idleIntervalMs: number;
  idleThresholdMs: number;
  activeMaxPosts: number;
  accountListUrl: string;
  cos: { bucket: string; region: string; secretId: string; secretKey: string };
  sqlitePath: string;
  proxy?: string;
  instarCallbackUrl?: string;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${key} 需要数值,收到: ${raw}`);
  return n;
}

function required(env: Env, key: string): string {
  const raw = env[key];
  if (raw === undefined || raw === "") throw new Error(`缺少必填环境变量 ${key}`);
  return raw;
}

export function loadConfig(env: Env): AppConfig {
  return {
    globalConcurrency: num(env, "GLOBAL_CONCURRENCY", 2),
    scheduleTickMs: num(env, "SCHEDULE_TICK_INTERVAL", 60_000),
    reconcileMs: num(env, "RECONCILE_INTERVAL", 300_000),
    leaseBaselineMs: num(env, "LEASE_BASELINE", 300_000),
    leaseHeartbeatMs: num(env, "LEASE_HEARTBEAT", 120_000),
    fetchDelayMinMs: num(env, "FETCH_DELAY_MIN", 2_000),
    fetchDelayMaxMs: num(env, "FETCH_DELAY_MAX", 8_000),
    postTimeoutMs: num(env, "POST_TIMEOUT", 300_000),
    retryBackoffMs: (env.RETRY_BACKOFF ?? "60000,180000,600000")
      .split(",")
      .map((s) => Number(s.trim())),
    retryMax: num(env, "RETRY_MAX", 3),
    activeMinIntervalMs: num(env, "ACTIVE_MIN_INTERVAL", 1_800_000),
    idleIntervalMs: num(env, "IDLE_INTERVAL", 21_600_000),
    idleThresholdMs: num(env, "IDLE_THRESHOLD", 86_400_000),
    activeMaxPosts: num(env, "ACTIVE_MAX_POSTS", 100),
    accountListUrl: required(env, "ACCOUNT_LIST_URL"),
    cos: {
      bucket: required(env, "COS_BUCKET"),
      region: required(env, "COS_REGION"),
      secretId: required(env, "COS_SECRET_ID"),
      secretKey: required(env, "COS_SECRET_KEY"),
    },
    sqlitePath: env.SQLITE_PATH && env.SQLITE_PATH !== "" ? env.SQLITE_PATH : "./data/worker.sqlite",
    proxy: env.YT_DLP_PROXY,
    instarCallbackUrl: env.INSTAR_CALLBACK_URL,
  };
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/config.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: add env-driven app config with defaults and required checks"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 3: Clock 抽象(可控时钟)

**Files:**
- Create: `src/clock.ts`
- Test: `src/clock.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface Clock {
    now(): number;                    // epoch ms
    sleep(ms: number): Promise<void>;
  }
  export class SystemClock implements Clock { now(): number; sleep(ms: number): Promise<void>; }
  export class ManualClock implements Clock {
    constructor(startMs?: number);
    now(): number;
    sleep(ms: number): Promise<void>; // 记录挂起的 sleep,advance 到时才 resolve
    advance(ms: number): Promise<void>; // 推进时间并 resolve 到期 sleep
  }
  ```
  `ManualClock.sleep` 不真等待;`advance(ms)` 把当前时间前进 `ms` 并 resolve 所有到期的 sleep。

- [x] **Step 1: 写失败测试**

```ts
// src/clock.test.ts
import { test, expect } from "bun:test";
import { ManualClock } from "./clock.ts";

test("ManualClock now 随 advance 推进", async () => {
  const clk = new ManualClock(1000);
  expect(clk.now()).toBe(1000);
  await clk.advance(500);
  expect(clk.now()).toBe(1500);
});

test("sleep 在 advance 到时后 resolve", async () => {
  const clk = new ManualClock(0);
  let done = false;
  const p = clk.sleep(100).then(() => { done = true; });
  await clk.advance(50);
  expect(done).toBe(false);
  await clk.advance(50);
  await p;
  expect(done).toBe(true);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/clock.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/clock.ts
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

interface Pending {
  at: number;
  resolve: () => void;
}

export class ManualClock implements Clock {
  private current: number;
  private pending: Pending[] = [];

  constructor(startMs = 0) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.pending.push({ at: this.current + ms, resolve });
    });
  }

  async advance(ms: number): Promise<void> {
    this.current += ms;
    const due = this.pending.filter((p) => p.at <= this.current);
    this.pending = this.pending.filter((p) => p.at > this.current);
    for (const p of due) p.resolve();
    // 让已 resolve 的微任务队列跑完
    await Promise.resolve();
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/clock.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/clock.ts src/clock.test.ts
git commit -m "feat: add injectable Clock with SystemClock and controllable ManualClock"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 4: 标准化 Post 结构与 PlatformAdapter 接口

**Files:**
- Create: `src/platform/adapter.ts`
- Test: `src/platform/adapter.test.ts`(类型契约冒烟测试)

**Interfaces:**
- Consumes: `ProcessStream`(from `src/types.ts`)
- Produces:
  ```ts
  export interface Post {
    platform: string;        // "tiktok"
    id: string;              // 平台内帖子唯一 id
    accountId: string;       // 归属账号(username)
    url: string;             // 详情/下载页 URL
    publishedAt: number;     // epoch ms(可能为估算)
    publishedEst: boolean;   // true=估算(缺原始时间)
    title?: string;
    raw?: unknown;           // 平台原始详情(仅内存传递,不持久化)
  }
  export interface PostRef {              // 列表阶段的轻量候选
    platform: string;
    id: string;
    accountId: string;
    url: string;
    listIndex: number;       // 在列表中的倒序位置(0=最新),供发布时间估算兜底
  }
  export interface MediaStream {
    stream: import("node:stream").Readable;
    exited: Promise<number>; // 子进程退出码
    abort(): void;           // kill 子进程
  }
  export interface PlatformAdapter {
    readonly platform: string;
    listPosts(accountId: string, lastVideoId?: string): Promise<PostRef[]>; // 倒序(最新在前)
    fetchDetail(ref: PostRef): Promise<unknown>;   // 原始详情
    cleanse(ref: PostRef, detail: unknown): Post;  // 标准化 + 发布时间降级
    openMediaStream(post: Post): MediaStream;
  }
  ```
  注:`MediaStream` 与既有 `ProcessStream` 形似但增加 `abort()`,供流水线超时中止。

- [x] **Step 1: 写失败测试(契约冒烟)**

```ts
// src/platform/adapter.test.ts
import { test, expect } from "bun:test";
import type { PlatformAdapter, Post, PostRef, MediaStream } from "./adapter.ts";
import { Readable } from "node:stream";

test("可实现一个最小 PlatformAdapter", () => {
  const adapter: PlatformAdapter = {
    platform: "fake",
    async listPosts() {
      return [{ platform: "fake", id: "1", accountId: "u", url: "http://x/1", listIndex: 0 }];
    },
    async fetchDetail() {
      return { timestamp: 100 };
    },
    cleanse(ref: PostRef): Post {
      return {
        platform: "fake",
        id: ref.id,
        accountId: ref.accountId,
        url: ref.url,
        publishedAt: 100_000,
        publishedEst: false,
      };
    },
    openMediaStream(): MediaStream {
      return { stream: Readable.from(["x"]), exited: Promise.resolve(0), abort() {} };
    },
  };
  expect(adapter.platform).toBe("fake");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/platform/adapter.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现(纯类型 + 无运行时逻辑)**

```ts
// src/platform/adapter.ts
import type { Readable } from "node:stream";

export interface Post {
  platform: string;
  id: string;
  accountId: string;
  url: string;
  publishedAt: number;
  publishedEst: boolean;
  title?: string;
  raw?: unknown;
}

export interface PostRef {
  platform: string;
  id: string;
  accountId: string;
  url: string;
  listIndex: number;
}

export interface MediaStream {
  stream: Readable;
  exited: Promise<number>;
  abort(): void;
}

export interface PlatformAdapter {
  readonly platform: string;
  listPosts(accountId: string, lastVideoId?: string): Promise<PostRef[]>;
  fetchDetail(ref: PostRef): Promise<unknown>;
  cleanse(ref: PostRef, detail: unknown): Post;
  openMediaStream(post: Post): MediaStream;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/platform/adapter.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/platform/adapter.ts src/platform/adapter.test.ts
git commit -m "feat: define platform-agnostic Post and PlatformAdapter interface"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 5: Store — SQLite schema 与建库

**Files:**
- Create: `src/store/schema.ts`
- Create: `src/store/store.ts`
- Test: `src/store/store.test.ts`

**Interfaces:**
- Consumes: `Clock`(from `src/clock.ts`)
- Produces:
  ```ts
  export interface AccountRow {
    platform: string;
    accountId: string;
    nextRunAt: number;
    lastPostAt: number | null;
    lastVideoId: string | null;
    active: boolean;
    leaseUntil: number | null;
  }
  export class Store {
    constructor(sqlitePath: string, clock: Clock); // ":memory:" 亦可
    close(): void;
    // 后续任务扩展方法
  }
  ```
  构造时执行 DDL(`CREATE TABLE IF NOT EXISTS`)并开启 `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`。

- [x] **Step 1: 写失败测试**

```ts
// src/store/store.test.ts
import { test, expect } from "bun:test";
import { Store } from "./store.ts";
import { ManualClock } from "../clock.ts";

test("建库后两张表存在", () => {
  const store = new Store(":memory:", new ManualClock(0));
  const names = store.tableNames();
  expect(names).toContain("accounts");
  expect(names).toContain("fetched_posts");
  store.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/store/store.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 schema**

```ts
// src/store/schema.ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS accounts (
  platform      TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  next_run_at   INTEGER NOT NULL,
  last_post_at  INTEGER,
  last_video_id TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  lease_until   INTEGER,
  PRIMARY KEY (platform, account_id)
);
CREATE TABLE IF NOT EXISTS fetched_posts (
  platform        TEXT NOT NULL,
  post_id         TEXT NOT NULL,
  published_at    INTEGER,
  published_est   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  fetched_at      INTEGER,
  PRIMARY KEY (platform, post_id)
);
`;
```

- [x] **Step 4: 实现 Store 骨架**

```ts
// src/store/store.ts
import { Database } from "bun:sqlite";
import type { Clock } from "../clock.ts";
import { SCHEMA_SQL } from "./schema.ts";

export interface AccountRow {
  platform: string;
  accountId: string;
  nextRunAt: number;
  lastPostAt: number | null;
  lastVideoId: string | null;
  active: boolean;
  leaseUntil: number | null;
}

export class Store {
  protected readonly db: Database;
  constructor(sqlitePath: string, protected readonly clock: Clock) {
    this.db = new Database(sqlitePath, { create: true });
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.db.run(SCHEMA_SQL);
  }

  tableNames(): string[] {
    const rows = this.db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    return rows.map((r) => r.name);
  }

  close(): void {
    this.db.close();
  }
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `bun test src/store/store.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/store/schema.ts src/store/store.ts src/store/store.test.ts
git commit -m "feat: add sqlite Store with WAL schema for accounts and fetched_posts"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 6: Store — 去重读写、账号 upsert 与游标推进

**Files:**
- Modify: `src/store/store.ts`
- Test: `src/store/store.test.ts`(追加用例)

**Interfaces:**
- Consumes: `AccountRow`(Task 5)
- Produces(新增 `Store` 方法):
  ```ts
  getAccount(platform: string, accountId: string): AccountRow | null;
  isFetched(platform: string, postId: string): boolean; // status=success 才算
  markSuccess(platform: string, postId: string, publishedAt: number, publishedEst: boolean): void;
  advanceCursor(platform: string, accountId: string, lastVideoId: string, lastPostAt: number): void;
  // 供后续任务:插入 active 账号(不覆盖已存在的调度状态)
  insertAccountIfAbsent(platform: string, accountId: string, nextRunAt: number): void;
  ```
  `markSuccess`:UPSERT 一行 status=success、fetched_at=now、attempts 保留、next_attempt_at 清空。

- [x] **Step 1: 写失败测试(追加)**

```ts
// 追加到 src/store/store.test.ts
import { AccountRow } from "./store.ts"; // 若已导入可省略

test("markSuccess 后 isFetched 为真,不重复", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  expect(store.isFetched("tiktok", "p1")).toBe(false);
  store.markSuccess("tiktok", "p1", 5000, false);
  expect(store.isFetched("tiktok", "p1")).toBe(true);
  store.close();
});

test("insertAccountIfAbsent 不覆盖已存在的 nextRunAt", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "u", 100);
  store.advanceCursor("tiktok", "u", "v9", 8000);
  store.insertAccountIfAbsent("tiktok", "u", 999999); // 不应覆盖
  const acc = store.getAccount("tiktok", "u")!;
  expect(acc.nextRunAt).toBe(100);
  expect(acc.lastVideoId).toBe("v9");
  expect(acc.lastPostAt).toBe(8000);
  store.close();
});

test("重启后去重记录保留(临时文件)", () => {
  const path = `/tmp/store-${Date.now()}.sqlite`;
  const s1 = new Store(path, new ManualClock(1000));
  s1.markSuccess("tiktok", "p1", 5000, false);
  s1.close();
  const s2 = new Store(path, new ManualClock(2000));
  expect(s2.isFetched("tiktok", "p1")).toBe(true);
  s2.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/store/store.test.ts`
Expected: FAIL(方法未定义)。

- [x] **Step 3: 实现方法(追加到 Store 类)**

```ts
  private rowToAccount(r: any): AccountRow {
    return {
      platform: r.platform,
      accountId: r.account_id,
      nextRunAt: r.next_run_at,
      lastPostAt: r.last_post_at,
      lastVideoId: r.last_video_id,
      active: r.active === 1,
      leaseUntil: r.lease_until,
    };
  }

  getAccount(platform: string, accountId: string): AccountRow | null {
    const r = this.db
      .query("SELECT * FROM accounts WHERE platform=? AND account_id=?")
      .get(platform, accountId);
    return r ? this.rowToAccount(r) : null;
  }

  isFetched(platform: string, postId: string): boolean {
    const r = this.db
      .query("SELECT 1 FROM fetched_posts WHERE platform=? AND post_id=? AND status='success'")
      .get(platform, postId);
    return r !== null;
  }

  markSuccess(platform: string, postId: string, publishedAt: number, publishedEst: boolean): void {
    this.db.run(
      `INSERT INTO fetched_posts (platform, post_id, published_at, published_est, status, attempts, next_attempt_at, fetched_at)
       VALUES (?, ?, ?, ?, 'success', COALESCE((SELECT attempts FROM fetched_posts WHERE platform=? AND post_id=?),0), NULL, ?)
       ON CONFLICT(platform, post_id) DO UPDATE SET
         published_at=excluded.published_at,
         published_est=excluded.published_est,
         status='success',
         next_attempt_at=NULL,
         fetched_at=excluded.fetched_at`,
      [platform, postId, publishedAt, publishedEst ? 1 : 0, platform, postId, this.clock.now()],
    );
  }

  advanceCursor(platform: string, accountId: string, lastVideoId: string, lastPostAt: number): void {
    this.db.run(
      "UPDATE accounts SET last_video_id=?, last_post_at=? WHERE platform=? AND account_id=?",
      [lastVideoId, lastPostAt, platform, accountId],
    );
  }

  insertAccountIfAbsent(platform: string, accountId: string, nextRunAt: number): void {
    this.db.run(
      `INSERT INTO accounts (platform, account_id, next_run_at, active)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(platform, account_id) DO NOTHING`,
      [platform, accountId, nextRunAt],
    );
  }
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/store/store.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/store/store.ts src/store/store.test.ts
git commit -m "feat: add dedup read/write, account upsert and cursor advance to Store"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 7: Store — lease 领取事务与心跳续租

**Files:**
- Modify: `src/store/store.ts`
- Test: `src/store/store.test.ts`(追加)

**Interfaces:**
- Consumes: `AccountRow`
- Produces:
  ```ts
  // 事务内:挑 active && next_run_at<=now && (lease_until IS NULL || <=now),
  // ORDER BY next_run_at ASC LIMIT n,选中即 UPDATE lease_until=now+baselineMs,返回被领的行
  leaseDueAccounts(platform: string, now: number, baselineMs: number, limit: number): AccountRow[];
  heartbeat(platform: string, accountId: string, leaseUntil: number): void;
  releaseLease(platform: string, accountId: string): void; // 置 lease_until=NULL
  ```
  `leaseDueAccounts` 必须在单个 `BEGIN IMMEDIATE` 事务里完成 select+update,保证并发调用不重复领同一账号。

- [x] **Step 1: 写失败测试(追加)**

```ts
test("leaseDueAccounts 只领到期且未租出的账号,并写 lease", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "due", 500);      // 到期
  store.insertAccountIfAbsent("tiktok", "future", 5000);  // 未到期
  const leased = store.leaseDueAccounts("tiktok", 1000, 300_000, 10);
  expect(leased.map((a) => a.accountId)).toEqual(["due"]);
  const acc = store.getAccount("tiktok", "due")!;
  expect(acc.leaseUntil).toBe(1000 + 300_000);
  store.close();
});

test("已租出且未过期的账号不被再次领取", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "u", 500);
  store.leaseDueAccounts("tiktok", 1000, 300_000, 10); // 领走
  const second = store.leaseDueAccounts("tiktok", 2000, 300_000, 10); // 租约未过期
  expect(second).toHaveLength(0);
  store.close();
});

test("租约过期后可被重领(崩溃恢复)", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "u", 500);
  store.leaseDueAccounts("tiktok", 1000, 300_000, 10);
  const after = store.leaseDueAccounts("tiktok", 1000 + 300_001, 300_000, 10);
  expect(after.map((a) => a.accountId)).toEqual(["u"]);
  store.close();
});

test("LIMIT 约束领取数量", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "a", 100);
  store.insertAccountIfAbsent("tiktok", "b", 200);
  store.insertAccountIfAbsent("tiktok", "c", 300);
  const leased = store.leaseDueAccounts("tiktok", 1000, 300_000, 2);
  expect(leased).toHaveLength(2);
  expect(leased.map((a) => a.accountId)).toEqual(["a", "b"]); // next_run_at ASC
  store.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/store/store.test.ts`
Expected: FAIL(方法未定义)。

- [x] **Step 3: 实现(追加到 Store)**

```ts
  leaseDueAccounts(platform: string, now: number, baselineMs: number, limit: number): AccountRow[] {
    if (limit <= 0) return [];
    const txn = this.db.transaction(() => {
      const rows = this.db
        .query(
          `SELECT * FROM accounts
           WHERE platform=? AND active=1 AND next_run_at<=?
             AND (lease_until IS NULL OR lease_until<=?)
           ORDER BY next_run_at ASC LIMIT ?`,
        )
        .all(platform, now, now, limit) as any[];
      const leaseUntil = now + baselineMs;
      for (const r of rows) {
        this.db.run("UPDATE accounts SET lease_until=? WHERE platform=? AND account_id=?", [
          leaseUntil,
          platform,
          r.account_id,
        ]);
        r.lease_until = leaseUntil;
      }
      return rows;
    });
    // BEGIN IMMEDIATE 语义:写事务立即拿锁,避免并发领取竞态
    const result = this.db.transaction(txn as any)();
    return (result as any[]).map((r) => this.rowToAccount(r));
  }

  heartbeat(platform: string, accountId: string, leaseUntil: number): void {
    this.db.run("UPDATE accounts SET lease_until=? WHERE platform=? AND account_id=?", [
      leaseUntil,
      platform,
      accountId,
    ]);
  }

  releaseLease(platform: string, accountId: string): void {
    this.db.run("UPDATE accounts SET lease_until=NULL WHERE platform=? AND account_id=?", [
      platform,
      accountId,
    ]);
  }
```

注:`this.db.transaction(fn)()` 是 bun:sqlite 的事务 API(同步闭包内的所有写入原子提交);若需要 IMMEDIATE 锁,用 `this.db.transaction(fn).immediate()`。实现时优先 `.immediate()`,若类型不支持则保留默认事务(WAL + busy_timeout 已足够单连接场景)。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/store/store.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/store/store.ts src/store/store.test.ts
git commit -m "feat: add transactional lease acquisition and heartbeat to Store"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 8: Store — reconcile upsert 与 inactive 标记

**Files:**
- Modify: `src/store/store.ts`
- Test: `src/store/store.test.ts`(追加)

**Interfaces:**
- Consumes: `AccountRow`
- Produces:
  ```ts
  listAccountIds(platform: string): string[];             // 全部(含 inactive)
  setActive(platform: string, accountId: string, active: boolean): void;
  // reconcile 用:插入新账号 next_run_at=now+jitter、active=1;
  //   已存在只保证 active=1,不动 next_run_at/last_post_at/lease
  reconcile(platform: string, wantedIds: string[], now: number, jitterFn: () => number): void;
  ```
  `reconcile` 语义:wanted 中不存在的插入;已存在的置 active=1(不覆盖调度状态);本地存在但不在 wanted 的置 active=0。

- [x] **Step 1: 写失败测试(追加)**

```ts
test("reconcile 新增账号 next_run_at=now+jitter 且 active", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.reconcile("tiktok", ["new"], 1000, () => 50);
  const acc = store.getAccount("tiktok", "new")!;
  expect(acc.active).toBe(true);
  expect(acc.nextRunAt).toBe(1050);
  store.close();
});

test("reconcile 已存在账号不覆盖 next_run_at/last_post_at", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "u", 100);
  store.advanceCursor("tiktok", "u", "v1", 7000);
  store.reconcile("tiktok", ["u"], 999999, () => 0);
  const acc = store.getAccount("tiktok", "u")!;
  expect(acc.nextRunAt).toBe(100);
  expect(acc.lastPostAt).toBe(7000);
  expect(acc.active).toBe(true);
  store.close();
});

test("reconcile 移除的账号标记 inactive 但保留去重历史", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.insertAccountIfAbsent("tiktok", "gone", 100);
  store.markSuccess("tiktok", "p1", 5000, false);
  store.reconcile("tiktok", [], 1000, () => 0);
  expect(store.getAccount("tiktok", "gone")!.active).toBe(false);
  expect(store.isFetched("tiktok", "p1")).toBe(true);
  store.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/store/store.test.ts`
Expected: FAIL(方法未定义)。

- [x] **Step 3: 实现(追加到 Store)**

```ts
  listAccountIds(platform: string): string[] {
    const rows = this.db
      .query("SELECT account_id FROM accounts WHERE platform=?")
      .all(platform) as any[];
    return rows.map((r) => r.account_id);
  }

  setActive(platform: string, accountId: string, active: boolean): void {
    this.db.run("UPDATE accounts SET active=? WHERE platform=? AND account_id=?", [
      active ? 1 : 0,
      platform,
      accountId,
    ]);
  }

  reconcile(platform: string, wantedIds: string[], now: number, jitterFn: () => number): void {
    const txn = this.db.transaction(() => {
      const existing = new Set(this.listAccountIds(platform));
      const wanted = new Set(wantedIds);
      for (const id of wantedIds) {
        if (existing.has(id)) {
          this.db.run("UPDATE accounts SET active=1 WHERE platform=? AND account_id=?", [platform, id]);
        } else {
          this.db.run(
            "INSERT INTO accounts (platform, account_id, next_run_at, active) VALUES (?, ?, ?, 1)",
            [platform, id, now + jitterFn()],
          );
        }
      }
      for (const id of existing) {
        if (!wanted.has(id)) {
          this.db.run("UPDATE accounts SET active=0 WHERE platform=? AND account_id=?", [platform, id]);
        }
      }
    });
    txn();
  }
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/store/store.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/store/store.ts src/store/store.test.ts
git commit -m "feat: add reconcile upsert and inactive marking to Store"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 9: Store — 退避帖子写入与 due 帖子/账号挑选

**Files:**
- Modify: `src/store/store.ts`
- Test: `src/store/store.test.ts`(追加)

**Interfaces:**
- Consumes: 无新增
- Produces:
  ```ts
  export interface FailedPost { platform: string; postId: string; attempts: number; nextAttemptAt: number; }
  // 记录一次失败:UPSERT status=failed, attempts+1, next_attempt_at=nextAttemptAt(由调用方按退避档位算好)
  markFailed(platform: string, postId: string, nextAttemptAt: number | null): void;
  getAttempts(platform: string, postId: string): number;
  // 挑到期待重试的失败帖子(status=failed 且 next_attempt_at<=now)
  dueFailedPosts(platform: string, now: number): FailedPost[];
  ```
  `markFailed`:attempts 自增;`next_attempt_at=null` 表示耗尽(最终 failed,不再被 `dueFailedPosts` 选中)。

- [x] **Step 1: 写失败测试(追加)**

```ts
test("markFailed 自增 attempts 并可被 dueFailedPosts 选中", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.markFailed("tiktok", "p1", 2000);
  expect(store.getAttempts("tiktok", "p1")).toBe(1);
  store.markFailed("tiktok", "p1", 3000);
  expect(store.getAttempts("tiktok", "p1")).toBe(2);
  const due = store.dueFailedPosts("tiktok", 3000);
  expect(due.map((p) => p.postId)).toEqual(["p1"]);
  expect(due[0]!.attempts).toBe(2);
  store.close();
});

test("未到期的失败帖子不被选中", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.markFailed("tiktok", "p1", 5000);
  expect(store.dueFailedPosts("tiktok", 1000)).toHaveLength(0);
  store.close();
});

test("next_attempt_at=null(耗尽)不再被选中", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.markFailed("tiktok", "p1", null);
  expect(store.dueFailedPosts("tiktok", 999999)).toHaveLength(0);
  store.close();
});

test("成功后不再被 dueFailedPosts 选中", () => {
  const store = new Store(":memory:", new ManualClock(1000));
  store.markFailed("tiktok", "p1", 2000);
  store.markSuccess("tiktok", "p1", 5000, false);
  expect(store.dueFailedPosts("tiktok", 999999)).toHaveLength(0);
  store.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/store/store.test.ts`
Expected: FAIL(方法未定义)。

- [x] **Step 3: 实现(追加到 Store)**

```ts
  markFailed(platform: string, postId: string, nextAttemptAt: number | null): void {
    this.db.run(
      `INSERT INTO fetched_posts (platform, post_id, status, attempts, next_attempt_at)
       VALUES (?, ?, 'failed', 1, ?)
       ON CONFLICT(platform, post_id) DO UPDATE SET
         status='failed',
         attempts=fetched_posts.attempts+1,
         next_attempt_at=excluded.next_attempt_at`,
      [platform, postId, nextAttemptAt],
    );
  }

  getAttempts(platform: string, postId: string): number {
    const r = this.db
      .query("SELECT attempts FROM fetched_posts WHERE platform=? AND post_id=?")
      .get(platform, postId) as any;
    return r ? r.attempts : 0;
  }

  dueFailedPosts(platform: string, now: number): import("./store.ts").FailedPost[] {
    const rows = this.db
      .query(
        `SELECT platform, post_id, attempts, next_attempt_at FROM fetched_posts
         WHERE platform=? AND status='failed' AND next_attempt_at IS NOT NULL AND next_attempt_at<=?`,
      )
      .all(platform, now) as any[];
    return rows.map((r) => ({
      platform: r.platform,
      postId: r.post_id,
      attempts: r.attempts,
      nextAttemptAt: r.next_attempt_at,
    }));
  }
```

并在文件顶部 export 类型:

```ts
export interface FailedPost {
  platform: string;
  postId: string;
  attempts: number;
  nextAttemptAt: number;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/store/store.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/store/store.ts src/store/store.test.ts
git commit -m "feat: add failed-post backoff persistence and due selection to Store"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 10: TikTokAdapter — listPosts(`-J --flat-playlist`)

**Files:**
- Create: `src/platform/tiktok/adapter.ts`
- Test: `src/platform/tiktok/adapter.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`(from `src/types.ts`)、`PostRef`(Task 4)
- Produces:
  ```ts
  export interface TikTokAdapterOptions { proxy?: string; }
  export class TikTokAdapter implements PlatformAdapter {
    readonly platform = "tiktok";
    constructor(runner: ProcessRunner, opts?: TikTokAdapterOptions);
    listPosts(accountId: string, lastVideoId?: string): Promise<PostRef[]>;
    // Task 11/12 补 fetchDetail/cleanse/openMediaStream
  }
  ```
  `listPosts`:构造账号主页 URL `https://www.tiktok.com/@<accountId>`,`args=["-J","--flat-playlist", (proxy?["--proxy",proxy]:[]), url]`,`runner.run` → 解析 `entries`。返回倒序(yt-dlp 主页默认最新在前),`listIndex` 为数组下标。`lastVideoId` 只用于 pipeline 过滤,adapter 不截断(本任务不处理 lastVideoId,原样返回全部候选)。

- [x] **Step 1: 写失败测试**

```ts
// src/platform/tiktok/adapter.test.ts
import { test, expect } from "bun:test";
import { TikTokAdapter } from "./adapter.ts";
import type { ProcessResult, ProcessRunner } from "../../types.ts";

function fakeRunner(stdout: string, calls: string[][] = []): ProcessRunner {
  return {
    async run(args) {
      calls.push(args);
      return { code: 0, stdout, stderr: "" } as ProcessResult;
    },
    runStream() {
      throw new Error("not used");
    },
  };
}

test("listPosts 解析 entries 为倒序 PostRef", async () => {
  const json = JSON.stringify({
    _type: "playlist",
    entries: [
      { id: "n2", url: "https://www.tiktok.com/@u/video/n2" },
      { id: "n1", url: "https://www.tiktok.com/@u/video/n1" },
    ],
  });
  const adapter = new TikTokAdapter(fakeRunner(json));
  const refs = await adapter.listPosts("u");
  expect(refs.map((r) => r.id)).toEqual(["n2", "n1"]);
  expect(refs[0]).toMatchObject({ platform: "tiktok", accountId: "u", listIndex: 0 });
});

test("listPosts 使用 -J --flat-playlist 与主页 URL", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ _type: "playlist", entries: [{ id: "a" }] });
  await new TikTokAdapter(fakeRunner(json, calls)).listPosts("u");
  expect(calls[0]).toContain("-J");
  expect(calls[0]).toContain("--flat-playlist");
  expect(calls[0]).toContain("https://www.tiktok.com/@u");
});

test("proxy 透传 --proxy", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ _type: "playlist", entries: [{ id: "a" }] });
  await new TikTokAdapter(fakeRunner(json, calls), { proxy: "http://127.0.0.1:2080" }).listPosts("u");
  expect(calls[0]).toContain("--proxy");
  expect(calls[0]).toContain("http://127.0.0.1:2080");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/platform/tiktok/adapter.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 listPosts(其余方法先抛未实现)**

```ts
// src/platform/tiktok/adapter.ts
import type { ProcessRunner } from "../../types.ts";
import type { MediaStream, PlatformAdapter, Post, PostRef } from "../adapter.ts";

export interface TikTokAdapterOptions {
  proxy?: string;
}

interface RawEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
}
interface RawList {
  entries?: RawEntry[];
}

export class TikTokAdapter implements PlatformAdapter {
  readonly platform = "tiktok";
  constructor(
    private readonly runner: ProcessRunner,
    private readonly opts: TikTokAdapterOptions = {},
  ) {}

  private proxyArgs(): string[] {
    return this.opts.proxy ? ["--proxy", this.opts.proxy] : [];
  }

  async listPosts(accountId: string, _lastVideoId?: string): Promise<PostRef[]> {
    const url = `https://www.tiktok.com/@${accountId}`;
    const args = ["-J", "--flat-playlist", ...this.proxyArgs(), url];
    const result = await this.runner.run(args);
    let data: RawList;
    try {
      data = JSON.parse(result.stdout) as RawList;
    } catch {
      throw new Error(`无法解析 yt-dlp 列表输出: ${result.stderr || result.stdout}`);
    }
    const entries = data.entries ?? [];
    return entries.map((e, i): PostRef => {
      const id = e.id ?? "";
      return {
        platform: this.platform,
        id,
        accountId,
        url: e.url ?? e.webpage_url ?? `https://www.tiktok.com/@${accountId}/video/${id}`,
        listIndex: i,
      };
    });
  }

  async fetchDetail(_ref: PostRef): Promise<unknown> {
    throw new Error("not implemented: fetchDetail (Task 11)");
  }

  cleanse(_ref: PostRef, _detail: unknown): Post {
    throw new Error("not implemented: cleanse (Task 11)");
  }

  openMediaStream(_post: Post): MediaStream {
    throw new Error("not implemented: openMediaStream (Task 12)");
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/platform/tiktok/adapter.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/platform/tiktok/adapter.ts src/platform/tiktok/adapter.test.ts
git commit -m "feat: implement TikTokAdapter.listPosts via yt-dlp flat-playlist"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 11: TikTokAdapter — fetchDetail(`-J`)与 cleanse(发布时间降级)

**Files:**
- Modify: `src/platform/tiktok/adapter.ts`
- Test: `src/platform/tiktok/adapter.test.ts`(追加)

**Interfaces:**
- Consumes: `PostRef`、`Post`
- Produces(实现两方法):
  - `fetchDetail(ref)`:`args=["-J", ...proxy, ref.url]` → `runner.run` → `JSON.parse(stdout)`。
  - `cleanse(ref, detail)`:发布时间优先级 `timestamp`(秒→ms)→`upload_date`(YYYYMMDD 当天 0 点 UTC→ms)→都无则 `publishedEst=true` 且 `publishedAt` 用 `ref.listIndex` 兜底占位(见下,由 pipeline 结合列表基准最终校正;adapter 侧先给 `0` 并置 est=true,pipeline 会重排)。为可测,cleanse 缺时间返回 `publishedAt=0, publishedEst=true`。

- [x] **Step 1: 写失败测试(追加)**

```ts
const ref = { platform: "tiktok", id: "p1", accountId: "u", url: "http://x/p1", listIndex: 0 };

test("fetchDetail 用 -J 与详情 URL", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "p1", timestamp: 1600000000 });
  const detail = await new TikTokAdapter(fakeRunner(json, calls)).fetchDetail(ref);
  expect(calls[0]).toContain("-J");
  expect(calls[0]).toContain("http://x/p1");
  expect((detail as any).timestamp).toBe(1600000000);
});

test("cleanse 优先用 timestamp(秒转毫秒)", () => {
  const post = new TikTokAdapter(fakeRunner("{}")).cleanse(ref, { timestamp: 1600000000, title: "T" });
  expect(post.publishedAt).toBe(1600000000 * 1000);
  expect(post.publishedEst).toBe(false);
  expect(post.title).toBe("T");
  expect(post.id).toBe("p1");
});

test("cleanse 缺 timestamp 用 upload_date 当天 0 点", () => {
  const post = new TikTokAdapter(fakeRunner("{}")).cleanse(ref, { upload_date: "20200101" });
  expect(post.publishedAt).toBe(Date.UTC(2020, 0, 1));
  expect(post.publishedEst).toBe(false);
});

test("cleanse 都缺时置 publishedEst=true", () => {
  const post = new TikTokAdapter(fakeRunner("{}")).cleanse(ref, {});
  expect(post.publishedEst).toBe(true);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/platform/tiktok/adapter.test.ts`
Expected: FAIL(抛 not implemented)。

- [x] **Step 3: 实现(替换 Task 10 的占位方法)**

```ts
  async fetchDetail(ref: PostRef): Promise<unknown> {
    const args = ["-J", ...this.proxyArgs(), ref.url];
    const result = await this.runner.run(args);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error(`无法解析 yt-dlp 详情输出: ${result.stderr || result.stdout}`);
    }
  }

  cleanse(ref: PostRef, detail: unknown): Post {
    const d = (detail ?? {}) as { timestamp?: number; upload_date?: string; title?: string };
    let publishedAt = 0;
    let publishedEst = true;
    if (typeof d.timestamp === "number" && Number.isFinite(d.timestamp)) {
      publishedAt = d.timestamp * 1000;
      publishedEst = false;
    } else if (typeof d.upload_date === "string" && /^\d{8}$/.test(d.upload_date)) {
      const y = Number(d.upload_date.slice(0, 4));
      const m = Number(d.upload_date.slice(4, 6));
      const day = Number(d.upload_date.slice(6, 8));
      publishedAt = Date.UTC(y, m - 1, day);
      publishedEst = false;
    }
    return {
      platform: this.platform,
      id: ref.id,
      accountId: ref.accountId,
      url: ref.url,
      publishedAt,
      publishedEst,
      title: d.title,
      raw: detail,
    };
  }
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/platform/tiktok/adapter.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/platform/tiktok/adapter.ts src/platform/tiktok/adapter.test.ts
git commit -m "feat: implement TikTokAdapter fetchDetail and cleanse with publish-time fallback"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 12: TikTokAdapter — openMediaStream(`-o -`)与中止

**Files:**
- Modify: `src/platform/tiktok/adapter.ts`
- Test: `src/platform/tiktok/adapter.test.ts`(追加)

**Interfaces:**
- Consumes: `ProcessRunner.runStream`、`Post`、`MediaStream`
- Produces:`openMediaStream(post)`:`args=["-o","-", ...proxy, post.url]`,调用 `runner.runStream(args)`,包装为 `MediaStream`:`stream=ps.stdout`、`exited=ps.exited`、`abort()` 触发底层 kill。为让 `abort` 可测且不依赖真实进程,`ProcessStream` 增加可选 `kill?()`(在 `src/types.ts` 扩展),`YtDlpRunner.runStream` 实现 `kill` 调用 `child.kill()`。`abort()` 调用 `ps.kill?.()`。

- [x] **Step 1: 扩展 ProcessStream 类型(先改类型)**

在 `src/types.ts` 的 `ProcessStream` 增加可选方法:

```ts
export interface ProcessStream {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
  kill?: () => void; // 中止底层子进程
}
```

并在 `src/ytdlp-manager/runner.ts` 的 `runStream` 返回值补 `kill`:

```ts
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      kill: () => child.kill(),
    };
```

- [x] **Step 2: 写失败测试(追加)**

```ts
import { Readable } from "node:stream";
import type { ProcessStream } from "../../types.ts";

function fakeStreamRunner(): { runner: ProcessRunner; killed: () => boolean; calls: string[][] } {
  let wasKilled = false;
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    async run() {
      throw new Error("not used");
    },
    runStream(args: string[]): ProcessStream {
      calls.push(args);
      return {
        stdout: Readable.from(["chunk"]),
        stderr: Readable.from([]),
        exited: Promise.resolve(0),
        kill: () => {
          wasKilled = true;
        },
      };
    },
  };
  return { runner, killed: () => wasKilled, calls };
}

const post = {
  platform: "tiktok",
  id: "p1",
  accountId: "u",
  url: "https://www.tiktok.com/@u/video/p1",
  publishedAt: 1,
  publishedEst: false,
};

test("openMediaStream 用 -o - 与详情 URL", () => {
  const { runner, calls } = fakeStreamRunner();
  const media = new TikTokAdapter(runner).openMediaStream(post);
  expect(calls[0]).toContain("-o");
  expect(calls[0]).toContain("-");
  expect(calls[0]).toContain(post.url);
  expect(media.stream).toBeDefined();
});

test("abort 触发底层 kill", () => {
  const { runner, killed } = fakeStreamRunner();
  const media = new TikTokAdapter(runner).openMediaStream(post);
  media.abort();
  expect(killed()).toBe(true);
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `bun test src/platform/tiktok/adapter.test.ts`
Expected: FAIL(openMediaStream 抛 not implemented)。

- [x] **Step 4: 实现(替换占位)**

```ts
  openMediaStream(post: Post): MediaStream {
    const args = ["-o", "-", ...this.proxyArgs(), post.url];
    const ps = this.runner.runStream(args);
    return {
      stream: ps.stdout,
      exited: ps.exited,
      abort: () => ps.kill?.(),
    };
  }
```

- [x] **Step 5: 跑测试确认通过**

Run: `bun test src/platform/tiktok/adapter.test.ts src/ytdlp-manager/runner.test.ts`
Expected: PASS(runner 现有测试不回归)。

- [x] **Step 6: 提交**

```bash
git add src/types.ts src/ytdlp-manager/runner.ts src/platform/tiktok/adapter.ts src/platform/tiktok/adapter.test.ts
git commit -m "feat: implement TikTokAdapter.openMediaStream with abortable child process"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 13: COS key 纯函数

**Files:**
- Create: `src/pipeline/cosKey.ts`
- Test: `src/pipeline/cosKey.test.ts`

**Interfaces:**
- Consumes: `Post`(Task 4)
- Produces:`export function cosKey(post: Post, now: Date): string;` 默认返回 `yyyyMMddHHmmss + post.id`(UTC)。`now` 参数注入便于测试。

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/cosKey.test.ts
import { test, expect } from "bun:test";
import { cosKey } from "./cosKey.ts";
import type { Post } from "../platform/adapter.ts";

const post: Post = {
  platform: "tiktok",
  id: "X",
  accountId: "u",
  url: "http://x",
  publishedAt: 0,
  publishedEst: false,
};

test("默认 key = yyyyMMddHHmmss + id", () => {
  const now = new Date(Date.UTC(2026, 6, 3, 12, 34, 56));
  expect(cosKey(post, now)).toBe("20260703123456X");
});

test("补零正确", () => {
  const now = new Date(Date.UTC(2026, 0, 5, 1, 2, 3));
  expect(cosKey({ ...post, id: "abc" }, now)).toBe("20260105010203abc");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/cosKey.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/pipeline/cosKey.ts
import type { Post } from "../platform/adapter.ts";

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

export function cosKey(post: Post, now: Date): string {
  const ts =
    `${now.getUTCFullYear()}` +
    pad(now.getUTCMonth() + 1) +
    pad(now.getUTCDate()) +
    pad(now.getUTCHours()) +
    pad(now.getUTCMinutes()) +
    pad(now.getUTCSeconds());
  return ts + post.id;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/cosKey.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/cosKey.ts src/pipeline/cosKey.test.ts
git commit -m "feat: add pure cosKey function (yyyyMMddHHmmss+id)"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 14: CosUploader — 流式 putObject 与 abort

**Files:**
- Create: `src/pipeline/uploader.ts`
- Test: `src/pipeline/uploader.test.ts`

**Interfaces:**
- Consumes: `cos-nodejs-sdk-v5`、`node:stream` `Readable`
- Produces:
  ```ts
  export interface Uploader {
    upload(stream: Readable, key: string, signal: AbortSignal): Promise<void>;
  }
  export interface CosClientLike {
    putObject(params: { Bucket: string; Region: string; Key: string; Body: Readable }): Promise<unknown>;
  }
  export class CosUploader implements Uploader {
    constructor(client: CosClientLike, opts: { bucket: string; region: string });
    upload(stream: Readable, key: string, signal: AbortSignal): Promise<void>;
  }
  export function createCosClient(cfg: { secretId: string; secretKey: string }): CosClientLike;
  ```
  `upload`:`putObject({Bucket,Region,Key:key,Body:stream})`;当 `signal.aborted` 或触发 abort 时 `stream.destroy()` 并 reject。**注意:此 `Uploader` 接口替换 `src/types.ts` 里旧的 `upload(filePath)` 语义**——旧接口随 CLI 一并在 Task 26 删除。本任务把新接口定义在 `src/pipeline/uploader.ts`,不动 `src/types.ts`(避免与尚存的旧 scheduler 冲突)。

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/uploader.test.ts
import { test, expect } from "bun:test";
import { Readable } from "node:stream";
import { CosUploader, type CosClientLike } from "./uploader.ts";

test("upload 调用 putObject 且传对 Bucket/Region/Key", async () => {
  let captured: any;
  const client: CosClientLike = {
    async putObject(params) {
      captured = params;
      return {};
    },
  };
  const uploader = new CosUploader(client, { bucket: "b", region: "r" });
  const ctrl = new AbortController();
  await uploader.upload(Readable.from(["x"]), "key1", ctrl.signal);
  expect(captured.Bucket).toBe("b");
  expect(captured.Region).toBe("r");
  expect(captured.Key).toBe("key1");
});

test("abort 时销毁流并 reject", async () => {
  const stream = Readable.from(["x"]);
  const client: CosClientLike = {
    putObject() {
      return new Promise(() => {}); // 永不 resolve
    },
  };
  const uploader = new CosUploader(client, { bucket: "b", region: "r" });
  const ctrl = new AbortController();
  const p = uploader.upload(stream, "key1", ctrl.signal);
  ctrl.abort();
  await expect(p).rejects.toThrow();
  expect(stream.destroyed).toBe(true);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/uploader.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/pipeline/uploader.ts
import type { Readable } from "node:stream";
import Cos from "cos-nodejs-sdk-v5";

export interface Uploader {
  upload(stream: Readable, key: string, signal: AbortSignal): Promise<void>;
}

export interface CosClientLike {
  putObject(params: {
    Bucket: string;
    Region: string;
    Key: string;
    Body: Readable;
  }): Promise<unknown>;
}

export function createCosClient(cfg: { secretId: string; secretKey: string }): CosClientLike {
  const cos = new Cos({ SecretId: cfg.secretId, SecretKey: cfg.secretKey });
  return {
    putObject(params) {
      return cos.putObject(params as any);
    },
  };
}

export class CosUploader implements Uploader {
  constructor(
    private readonly client: CosClientLike,
    private readonly opts: { bucket: string; region: string },
  ) {}

  upload(stream: Readable, key: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        stream.destroy(new Error("aborted"));
        reject(new Error("upload aborted"));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      this.client
        .putObject({ Bucket: this.opts.bucket, Region: this.opts.region, Key: key, Body: stream })
        .then(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        })
        .catch((err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        });
    });
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/uploader.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/uploader.ts src/pipeline/uploader.test.ts
git commit -m "feat: add streaming CosUploader with abort support"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 15: CallbackSink 接口与预留实现

**Files:**
- Create: `src/pipeline/callbackSink.ts`
- Test: `src/pipeline/callbackSink.test.ts`

**Interfaces:**
- Consumes: `Post`
- Produces:
  ```ts
  export interface CallbackSink {
    send(post: Post): Promise<void>;
  }
  export class NoopCallbackSink implements CallbackSink { send(post: Post): Promise<void>; } // 记录调用即可
  export class HttpCallbackSink implements CallbackSink {   // 预留:配置了 url 才真发
    constructor(url: string, fetchImpl?: typeof fetch);
    send(post: Post): Promise<void>;
  }
  ```

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/callbackSink.test.ts
import { test, expect } from "bun:test";
import { NoopCallbackSink, HttpCallbackSink } from "./callbackSink.ts";
import type { Post } from "../platform/adapter.ts";

const post: Post = {
  platform: "tiktok", id: "p1", accountId: "u", url: "http://x",
  publishedAt: 100, publishedEst: false,
};

test("NoopCallbackSink.send 不抛错", async () => {
  await new NoopCallbackSink().send(post);
});

test("HttpCallbackSink POST 标准化数据到 url", async () => {
  let captured: { url: string; body: any } | undefined;
  const fakeFetch = (async (url: string, init: any) => {
    captured = { url, body: JSON.parse(init.body) };
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await new HttpCallbackSink("http://instar/cb", fakeFetch).send(post);
  expect(captured!.url).toBe("http://instar/cb");
  expect(captured!.body.id).toBe("p1");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/callbackSink.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/pipeline/callbackSink.ts
import type { Post } from "../platform/adapter.ts";

export interface CallbackSink {
  send(post: Post): Promise<void>;
}

export class NoopCallbackSink implements CallbackSink {
  public sent: Post[] = [];
  async send(post: Post): Promise<void> {
    this.sent.push(post);
  }
}

export class HttpCallbackSink implements CallbackSink {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(post: Post): Promise<void> {
    const payload = {
      platform: post.platform,
      id: post.id,
      accountId: post.accountId,
      url: post.url,
      publishedAt: post.publishedAt,
      publishedEst: post.publishedEst,
      title: post.title,
    };
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`回传失败: HTTP ${res.status}`);
  }
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/callbackSink.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/callbackSink.ts src/pipeline/callbackSink.test.ts
git commit -m "feat: add CallbackSink interface with noop and reserved http impl"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 16: 随机延迟工具(Clock 可测)

**Files:**
- Create: `src/pipeline/delay.ts`
- Test: `src/pipeline/delay.test.ts`

**Interfaces:**
- Consumes: `Clock`(Task 3)
- Produces:`export function randomDelayMs(minMs: number, maxMs: number, rand?: () => number): number;`(默认 `Math.random`)、`export async function randomSleep(clock: Clock, minMs: number, maxMs: number, rand?: () => number): Promise<number>;`(用 `clock.sleep` 等待并返回实际延迟)。

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/delay.test.ts
import { test, expect } from "bun:test";
import { randomDelayMs, randomSleep } from "./delay.ts";
import { ManualClock } from "../clock.ts";

test("randomDelayMs 落在 [min,max]", () => {
  expect(randomDelayMs(2000, 8000, () => 0)).toBe(2000);
  expect(randomDelayMs(2000, 8000, () => 1)).toBe(8000);
  expect(randomDelayMs(2000, 8000, () => 0.5)).toBe(5000);
});

test("randomSleep 用 Clock 等待,不真 sleep", async () => {
  const clk = new ManualClock(0);
  let resolved = false;
  const p = randomSleep(clk, 2000, 8000, () => 0).then((d) => {
    resolved = true;
    return d;
  });
  expect(resolved).toBe(false);
  await clk.advance(2000);
  const delay = await p;
  expect(delay).toBe(2000);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/delay.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/pipeline/delay.ts
import type { Clock } from "../clock.ts";

export function randomDelayMs(minMs: number, maxMs: number, rand: () => number = Math.random): number {
  return Math.round(minMs + (maxMs - minMs) * rand());
}

export async function randomSleep(
  clock: Clock,
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): Promise<number> {
  const d = randomDelayMs(minMs, maxMs, rand);
  await clock.sleep(d);
  return d;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/delay.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/delay.ts src/pipeline/delay.test.ts
git commit -m "feat: add clock-driven random delay helper for anti-throttle"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 17: FetchPipeline — 候选过滤、排序与主动 100 条上限

**Files:**
- Create: `src/pipeline/pipeline.ts`
- Test: `src/pipeline/pipeline.test.ts`

**Interfaces:**
- Consumes: `PostRef`(Task 4)、`Store.isFetched`(Task 6)
- Produces:
  ```ts
  export interface FilterOptions {
    lastVideoId?: string;   // 游标:该 id 及其之前(倒序更后)的候选丢弃
    activeMaxPosts?: number; // 主动模式:截取最近 N 条(倒序前 N)
  }
  // 纯函数:输入倒序候选(最新在前),输出「按发布顺序从旧到新」的待抓 ref。
  // 已 success 的(isFetched)剔除;命中 lastVideoId 处及其后(更旧)截断。
  export function selectCandidates(
    refs: PostRef[],
    isFetched: (platform: string, id: string) => boolean,
    opts: FilterOptions,
  ): PostRef[];
  ```
  语义:
  1. 倒序 refs(index 0=最新);
  2. 若有 `activeMaxPosts`,先取前 `N`(最近 N 条);
  3. 命中 `lastVideoId`:从该 id 位置起(含)全部丢弃(视为已抓过的旧帖);
  4. 逐个查 `isFetched` 跳过已 success;
  5. `reverse()` 得从旧到新。

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/pipeline.test.ts
import { test, expect } from "bun:test";
import { selectCandidates } from "./pipeline.ts";
import type { PostRef } from "../platform/adapter.ts";

function refs(ids: string[]): PostRef[] {
  return ids.map((id, i) => ({ platform: "tiktok", id, accountId: "u", url: `http://x/${id}`, listIndex: i }));
}
const never = () => false;

test("无游标无上限:全部按从旧到新返回", () => {
  const out = selectCandidates(refs(["n3", "n2", "n1"]), never, {});
  expect(out.map((r) => r.id)).toEqual(["n1", "n2", "n3"]);
});

test("lastVideoId 命中处及更旧的被丢弃", () => {
  const out = selectCandidates(refs(["n3", "n2", "n1"]), never, { lastVideoId: "n1" });
  expect(out.map((r) => r.id)).toEqual(["n2", "n3"]);
});

test("已 success 的被去重跳过", () => {
  const fetched = (_p: string, id: string) => id === "n2";
  const out = selectCandidates(refs(["n3", "n2", "n1"]), fetched, {});
  expect(out.map((r) => r.id)).toEqual(["n1", "n3"]);
});

test("activeMaxPosts 只取最近 N 条", () => {
  const out = selectCandidates(refs(["n5", "n4", "n3", "n2", "n1"]), never, { activeMaxPosts: 2 });
  expect(out.map((r) => r.id)).toEqual(["n4", "n5"]); // 最近 2 条 n5,n4 → 从旧到新
});

test("activeMaxPosts 与去重同时生效", () => {
  const fetched = (_p: string, id: string) => id === "n5";
  const out = selectCandidates(refs(["n5", "n4", "n3"]), fetched, { activeMaxPosts: 2 });
  expect(out.map((r) => r.id)).toEqual(["n4"]);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/pipeline.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 selectCandidates**

```ts
// src/pipeline/pipeline.ts
import type { PostRef } from "../platform/adapter.ts";

export interface FilterOptions {
  lastVideoId?: string;
  activeMaxPosts?: number;
}

export function selectCandidates(
  refs: PostRef[],
  isFetched: (platform: string, id: string) => boolean,
  opts: FilterOptions,
): PostRef[] {
  let list = refs;
  if (opts.activeMaxPosts !== undefined) {
    list = list.slice(0, opts.activeMaxPosts);
  }
  if (opts.lastVideoId !== undefined) {
    const idx = list.findIndex((r) => r.id === opts.lastVideoId);
    if (idx >= 0) list = list.slice(0, idx);
  }
  list = list.filter((r) => !isFetched(r.platform, r.id));
  return [...list].reverse();
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/pipeline.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/pipeline.ts src/pipeline/pipeline.test.ts
git commit -m "feat: add candidate filtering, dedup, cursor cutoff and active-limit"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 18: FetchPipeline — 逐帖端到端处理(延迟/详情/清洗/上传/超时/退避/回传/去重)

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Test: `src/pipeline/pipeline.test.ts`(追加)

**Interfaces:**
- Consumes: `PlatformAdapter`、`Uploader`(Task 14)、`CallbackSink`(Task 15)、`Store`、`Clock`、`cosKey`(Task 13)、`randomSleep`(Task 16)、`selectCandidates`(Task 17)
- Produces:
  ```ts
  export interface PipelineDeps {
    adapter: PlatformAdapter;
    uploader: Uploader;
    sink: CallbackSink;
    store: Store;
    clock: Clock;
    postTimeoutMs: number;
    fetchDelayMinMs: number;
    fetchDelayMaxMs: number;
    retryBackoffMs: number[];
    retryMax: number;
    rand?: () => number;      // 测试注入(延迟)
  }
  export interface FetchRequest {
    accountId: string;
    lastVideoId?: string;
    activeMaxPosts?: number;  // 主动模式传 100
    onlyPostIds?: string[];   // 退避重拉:只处理这些 post_id(用 ref 直抓)
  }
  export interface FetchResult { newPosts: number; latestPostAt: number | null; latestVideoId: string | null; }
  export class FetchPipeline {
    constructor(deps: PipelineDeps);
    run(req: FetchRequest): Promise<FetchResult>;
  }
  ```
  单帖处理:随机延迟 → `fetchDetail` → `cleanse` → 打开媒体流 + `uploader.upload(stream, cosKey(post, new Date(clock.now())), signal)`,整体包 `postTimeoutMs`(用 `AbortController` + `clock` 定时;超时 abort 媒体流与上传)→ 成功判据 `exited===0 && upload resolve`;成功则 `sink.send`(失败只记录不回滚)+ `store.markSuccess` + 推进游标;失败则按 `attempts` 查退避档位写 `store.markFailed`(耗尽传 `null`)。单帖失败不影响其余。返回本轮 newPosts 数与最新时间/视频 id。

  超时实现要点(可测):用 `Promise.race([work, timeout])`,`timeout` 用 `clock.sleep(postTimeoutMs)` 后 `abort()`;`ManualClock.advance` 可驱动超时。

- [x] **Step 1: 写失败测试(追加)**

```ts
import { FetchPipeline, type PipelineDeps } from "./pipeline.ts";
import { Store } from "../store/store.ts";
import { ManualClock } from "../clock.ts";
import { NoopCallbackSink } from "./callbackSink.ts";
import { Readable } from "node:stream";
import type { PlatformAdapter, Post, PostRef, MediaStream } from "../platform/adapter.ts";
import type { Uploader } from "./uploader.ts";

function makePost(id: string, publishedAt: number): Post {
  return { platform: "tiktok", id, accountId: "u", url: `http://x/${id}`, publishedAt, publishedEst: false };
}

function fakeAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    platform: "tiktok",
    async listPosts() {
      return [];
    },
    async fetchDetail(ref: PostRef) {
      return { id: ref.id };
    },
    cleanse(ref: PostRef): Post {
      return makePost(ref.id, Number(ref.id.replace(/\D/g, "")) || 1);
    },
    openMediaStream(): MediaStream {
      return { stream: Readable.from(["x"]), exited: Promise.resolve(0), abort() {} };
    },
    ...overrides,
  };
}

class OkUploader implements Uploader {
  public keys: string[] = [];
  async upload(_s: Readable, key: string): Promise<void> {
    this.keys.push(key);
  }
}

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  const clock = new ManualClock(1_600_000_000_000);
  return {
    adapter: fakeAdapter(),
    uploader: new OkUploader(),
    sink: new NoopCallbackSink(),
    store: new Store(":memory:", clock),
    clock,
    postTimeoutMs: 300_000,
    fetchDelayMinMs: 0,
    fetchDelayMaxMs: 0,
    retryBackoffMs: [60_000, 180_000, 600_000],
    retryMax: 3,
    rand: () => 0,
    ...over,
  };
}

test("成功帖子:上传+回传+markSuccess,去重生效", async () => {
  const uploader = new OkUploader();
  const sink = new NoopCallbackSink();
  const d = deps({ uploader, sink });
  const adapter = { ...fakeAdapter(), async listPosts() { return refs(["p2", "p1"]); } };
  const pipe = new FetchPipeline({ ...d, adapter });
  const res = await pipe.run({ accountId: "u" });
  expect(res.newPosts).toBe(2);
  expect(uploader.keys).toHaveLength(2);
  expect(sink.sent.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  expect(d.store.isFetched("tiktok", "p1")).toBe(true);
});

test("上传失败:写 markFailed 且不 markSuccess,不影响其他帖子", async () => {
  const failing: Uploader = {
    async upload(_s, key) {
      if (key.endsWith("bad")) throw new Error("upload boom");
    },
  };
  const d = deps({ uploader: failing });
  const adapter = { ...fakeAdapter(), async listPosts() { return refs(["good", "bad"]); } };
  const pipe = new FetchPipeline({ ...d, adapter });
  await pipe.run({ accountId: "u" });
  expect(d.store.isFetched("tiktok", "good")).toBe(true);
  expect(d.store.isFetched("tiktok", "bad")).toBe(false);
  expect(d.store.getAttempts("tiktok", "bad")).toBe(1);
});

test("回传失败不回滚 markSuccess", async () => {
  const throwingSink = { async send() { throw new Error("callback boom"); } };
  const d = deps({ sink: throwingSink });
  const adapter = { ...fakeAdapter(), async listPosts() { return refs(["p1"]); } };
  const pipe = new FetchPipeline({ ...d, adapter });
  await pipe.run({ accountId: "u" });
  expect(d.store.isFetched("tiktok", "p1")).toBe(true);
});

test("退避档位随 attempts 递增,耗尽后 next_attempt_at=null", async () => {
  const d = deps();
  const adapter = {
    ...fakeAdapter(),
    async listPosts() { return refs(["p1"]); },
    openMediaStream(): MediaStream {
      return { stream: Readable.from(["x"]), exited: Promise.resolve(1), abort() {} }; // 退出码非0
    },
  };
  const pipe = new FetchPipeline({ ...d, adapter });
  await pipe.run({ accountId: "u" });                          // attempts 1 → backoff[0]=1m
  const due1 = d.store.dueFailedPosts("tiktok", d.clock.now() + 60_000);
  expect(due1).toHaveLength(1);
  await pipe.run({ accountId: "u", onlyPostIds: ["p1"] });     // attempts 2 → backoff[1]
  await pipe.run({ accountId: "u", onlyPostIds: ["p1"] });     // attempts 3 → backoff[2]
  await pipe.run({ accountId: "u", onlyPostIds: ["p1"] });     // attempts 4 → 耗尽 null
  expect(d.store.dueFailedPosts("tiktok", d.clock.now() + 10 ** 12)).toHaveLength(0);
});
```

> `refs` 复用 Task 17 测试文件里已定义的 helper(同一文件,无需重复定义)。

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/pipeline.test.ts`
Expected: FAIL(`FetchPipeline` 未定义)。

- [x] **Step 3: 实现 FetchPipeline(追加到 pipeline.ts)**

```ts
import type { MediaStream, PlatformAdapter, Post, PostRef } from "../platform/adapter.ts";
import type { Uploader } from "./uploader.ts";
import type { CallbackSink } from "./callbackSink.ts";
import type { Store } from "../store/store.ts";
import type { Clock } from "../clock.ts";
import { cosKey } from "./cosKey.ts";
import { randomSleep } from "./delay.ts";

export interface PipelineDeps {
  adapter: PlatformAdapter;
  uploader: Uploader;
  sink: CallbackSink;
  store: Store;
  clock: Clock;
  postTimeoutMs: number;
  fetchDelayMinMs: number;
  fetchDelayMaxMs: number;
  retryBackoffMs: number[];
  retryMax: number;
  rand?: () => number;
}

export interface FetchRequest {
  accountId: string;
  lastVideoId?: string;
  activeMaxPosts?: number;
  onlyPostIds?: string[];
}

export interface FetchResult {
  newPosts: number;
  latestPostAt: number | null;
  latestVideoId: string | null;
}

export class FetchPipeline {
  constructor(private readonly d: PipelineDeps) {}

  async run(req: FetchRequest): Promise<FetchResult> {
    const platform = this.d.adapter.platform;
    const all = await this.d.adapter.listPosts(req.accountId, req.lastVideoId);
    let candidates: PostRef[];
    if (req.onlyPostIds && req.onlyPostIds.length > 0) {
      const wanted = new Set(req.onlyPostIds);
      candidates = all.filter((r) => wanted.has(r.id)); // 直抓指定帖(不查去重)
    } else {
      candidates = selectCandidates(all, (p, id) => this.d.store.isFetched(p, id), {
        lastVideoId: req.lastVideoId,
        activeMaxPosts: req.activeMaxPosts,
      });
    }

    let newPosts = 0;
    let latestPostAt: number | null = null;
    let latestVideoId: string | null = null;

    for (const ref of candidates) {
      await randomSleep(this.d.clock, this.d.fetchDelayMinMs, this.d.fetchDelayMaxMs, this.d.rand);
      const ok = await this.processOne(ref);
      if (ok) {
        newPosts += 1;
      }
    }
    return { newPosts, latestPostAt, latestVideoId };

    // 内部:处理单帖,成功返回 true
    async function nothing() {}
  }

  private async processOne(ref: PostRef): Promise<boolean> {
    const platform = this.d.adapter.platform;
    let post: Post;
    try {
      const detail = await this.d.adapter.fetchDetail(ref);
      post = this.d.adapter.cleanse(ref, detail);
    } catch {
      this.recordFailure(platform, ref.id);
      return false;
    }

    const controller = new AbortController();
    let media: MediaStream | undefined;
    let timedOut = false;
    const timeout = this.d.clock.sleep(this.d.postTimeoutMs).then(() => {
      timedOut = true;
      controller.abort();
      media?.abort();
    });

    try {
      media = this.d.adapter.openMediaStream(post);
      const key = cosKey(post, new Date(this.d.clock.now()));
      const uploadP = this.d.uploader.upload(media.stream, key, controller.signal);
      const [code] = await Promise.all([media.exited, uploadP]);
      if (timedOut || code !== 0) {
        this.recordFailure(platform, ref.id);
        return false;
      }
    } catch {
      controller.abort();
      media?.abort();
      this.recordFailure(platform, ref.id);
      return false;
    }

    // 成功
    this.d.store.markSuccess(platform, post.id, post.publishedAt, post.publishedEst);
    this.d.store.advanceCursor(platform, ref.accountId, post.id, post.publishedAt);
    try {
      await this.d.sink.send(post);
    } catch {
      // 回传失败不回滚 success
    }
    return true;
  }

  private recordFailure(platform: string, postId: string): void {
    const attempts = this.d.store.getAttempts(platform, postId); // 当前已记的次数
    const nextIdx = attempts; // 本次失败后将变为 attempts+1;下次重试用 backoff[attempts]
    const backoff =
      nextIdx < this.d.retryBackoffMs.length ? this.d.retryBackoffMs[nextIdx] : null;
    const nextAttemptAt = backoff === null ? null : this.d.clock.now() + backoff;
    // markFailed 内部会 attempts+1;耗尽(attempts+1 > retryMax)时置 null
    const willBe = attempts + 1;
    this.d.store.markFailed(platform, postId, willBe > this.d.retryMax ? null : nextAttemptAt);
  }
}
```

> 实现注意:上面 `run` 内联的 `latestPostAt/latestVideoId` 需在 `processOne` 成功后回填。改为在 `processOne` 返回成功时,由 `run` 读取 `post` 信息更新。简化做法:`processOne` 返回 `{ ok: boolean; post?: Post }`,`run` 据此更新 `latestPostAt=max`、`latestVideoId=最后成功的 id`。实现时按此调整签名(测试只断言 `newPosts` 与 store 状态,`latest*` 由 Task 20 的调度器使用)。

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/pipeline.test.ts`
Expected: PASS。

- [x] **Step 5: 单帖超时测试(追加,验证中止)**

```ts
test("单帖上传超时:abort 媒体流并判失败", async () => {
  const d = deps({ postTimeoutMs: 1000 });
  let aborted = false;
  const adapter = {
    ...fakeAdapter(),
    async listPosts() { return refs(["p1"]); },
    openMediaStream(): MediaStream {
      return {
        stream: Readable.from(["x"]),
        exited: new Promise(() => {}), // 永不结束
        abort() { aborted = true; },
      };
    },
  };
  const hangingUploader: Uploader = { upload() { return new Promise(() => {}); } };
  const pipe = new FetchPipeline({ ...d, adapter, uploader: hangingUploader });
  const clock = d.clock as ManualClock;
  const p = pipe.run({ accountId: "u" });
  await clock.advance(1000); // 触发超时
  await p;
  expect(aborted).toBe(true);
  expect(d.store.getAttempts("tiktok", "p1")).toBe(1);
});
```

Run: `bun test src/pipeline/pipeline.test.ts`
Expected: PASS(如超时未触发,检查 `Promise.race`/`advance` 交互并调整为 `randomSleep` 用 `rand:()=>0` 使延迟为 0)。

- [x] **Step 6: 提交**

```bash
git add src/pipeline/pipeline.ts src/pipeline/pipeline.test.ts
git commit -m "feat: implement FetchPipeline per-post processing with timeout, backoff, callback"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 19: 自适应 next_run_at 纯函数

**Files:**
- Create: `src/pipeline/nextRun.ts`
- Test: `src/pipeline/nextRun.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  ```ts
  export interface NextRunInput {
    now: number;
    hasNewPosts: boolean;
    lastPostAt: number | null;    // 本账号已知最新发布时间
    activeMinIntervalMs: number;  // 30min 下限
    idleIntervalMs: number;       // 6h
    idleThresholdMs: number;      // 24h
  }
  export function computeNextRunAt(input: NextRunInput): number;
  ```
  规则:若 `!hasNewPosts` 且 `lastPostAt` 存在且 `now - lastPostAt >= idleThresholdMs` → `now + idleIntervalMs`;否则 `now + max(activeMinIntervalMs, 动态间隔)`。动态间隔 MVP 取 `activeMinIntervalMs`(即高频账号按下限 30min;设计允许 MAY 提频,取下限即满足"不低于 30min")。

- [x] **Step 1: 写失败测试**

```ts
// src/pipeline/nextRun.test.ts
import { test, expect } from "bun:test";
import { computeNextRunAt } from "./nextRun.ts";

const base = {
  now: 1_000_000,
  activeMinIntervalMs: 1_800_000,
  idleIntervalMs: 21_600_000,
  idleThresholdMs: 86_400_000,
};

test("有新帖:now + 30min 下限", () => {
  expect(computeNextRunAt({ ...base, hasNewPosts: true, lastPostAt: base.now })).toBe(base.now + 1_800_000);
});

test("连续 24h 无新帖:降到 now + 6h", () => {
  const lastPostAt = base.now - 86_400_000; // 恰好 24h 前
  expect(computeNextRunAt({ ...base, hasNewPosts: false, lastPostAt })).toBe(base.now + 21_600_000);
});

test("无新帖但未满 24h:仍按 30min 下限", () => {
  const lastPostAt = base.now - 1000;
  expect(computeNextRunAt({ ...base, hasNewPosts: false, lastPostAt })).toBe(base.now + 1_800_000);
});

test("lastPostAt 为空:按 30min 下限", () => {
  expect(computeNextRunAt({ ...base, hasNewPosts: false, lastPostAt: null })).toBe(base.now + 1_800_000);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/pipeline/nextRun.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/pipeline/nextRun.ts
export interface NextRunInput {
  now: number;
  hasNewPosts: boolean;
  lastPostAt: number | null;
  activeMinIntervalMs: number;
  idleIntervalMs: number;
  idleThresholdMs: number;
}

export function computeNextRunAt(input: NextRunInput): number {
  const { now, hasNewPosts, lastPostAt, activeMinIntervalMs, idleIntervalMs, idleThresholdMs } = input;
  if (!hasNewPosts && lastPostAt !== null && now - lastPostAt >= idleThresholdMs) {
    return now + idleIntervalMs;
  }
  return now + Math.max(activeMinIntervalMs, activeMinIntervalMs);
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/pipeline/nextRun.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/pipeline/nextRun.ts src/pipeline/nextRun.test.ts
git commit -m "feat: add adaptive next_run_at computation with idle downshift"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 20: Scheduler — 并发信号量、due tick、lease 心跳、自适应回写

**Files:**
- Create: `src/scheduler/scheduler.ts`
- Test: `src/scheduler/scheduler.test.ts`

**Interfaces:**
- Consumes: `Store`(leaseDueAccounts/heartbeat/releaseLease/getAccount/advanceCursor)、`FetchPipeline`、`Clock`、`computeNextRunAt`(Task 19)、`AppConfig`
- Produces:
  ```ts
  export interface SchedulerDeps {
    store: Store;
    pipeline: FetchPipeline;
    clock: Clock;
    platform: string;
    config: Pick<AppConfig,
      "globalConcurrency" | "leaseBaselineMs" | "leaseHeartbeatMs" |
      "activeMinIntervalMs" | "idleIntervalMs" | "idleThresholdMs" | "activeMaxPosts">;
  }
  export class Scheduler {
    constructor(deps: SchedulerDeps);
    runningCount(): number;
    // 领取到期账号(受剩余额度约束)并各自跑一批;返回本 tick 处理的账号数
    tick(): Promise<number>;
    // 供 HTTP 主动触发:立即领取指定账号并跑(仍走同一 lease 互斥与并发额度)
    // 由 Task 23 使用
  }
  ```
  `tick`:`remaining = globalConcurrency - runningCount()`;`store.leaseDueAccounts(platform, now, leaseBaselineMs, remaining)`;对每个领到的账号:占用一个并发槽、起 lease 心跳定时(每 `leaseHeartbeatMs` 调 `heartbeat(now+leaseBaselineMs)`)、跑 `pipeline.run({accountId, lastVideoId})`、结束后 `computeNextRunAt` 回写 `next_run_at`、停心跳、`releaseLease`、释放槽。同账号串行由 lease 保证。异常必须释放 lease 与槽。

- [x] **Step 1: 写失败测试**

```ts
// src/scheduler/scheduler.test.ts
import { test, expect } from "bun:test";
import { Scheduler } from "./scheduler.ts";
import { Store } from "../store/store.ts";
import { ManualClock } from "../clock.ts";

function fakePipeline(record: string[], opts: { delayMs?: number; newPosts?: number } = {}) {
  return {
    async run(req: { accountId: string }) {
      record.push(`start:${req.accountId}`);
      return { newPosts: opts.newPosts ?? 1, latestPostAt: 5000, latestVideoId: "v" };
    },
  } as any;
}

const cfg = {
  globalConcurrency: 2,
  leaseBaselineMs: 300_000,
  leaseHeartbeatMs: 120_000,
  activeMinIntervalMs: 1_800_000,
  idleIntervalMs: 21_600_000,
  idleThresholdMs: 86_400_000,
  activeMaxPosts: 100,
};

test("tick 只挑到期账号并受并发额度约束", async () => {
  const clock = new ManualClock(1_000_000);
  const store = new Store(":memory:", clock);
  store.insertAccountIfAbsent("tiktok", "a", 500_000);
  store.insertAccountIfAbsent("tiktok", "b", 500_000);
  store.insertAccountIfAbsent("tiktok", "c", 500_000);
  store.insertAccountIfAbsent("tiktok", "future", 9_000_000);
  const record: string[] = [];
  const sched = new Scheduler({ store, pipeline: fakePipeline(record), clock, platform: "tiktok", config: cfg });
  const n = await sched.tick();
  expect(n).toBe(2); // 并发上限 2
  expect(record.filter((r) => r.startsWith("start:"))).toHaveLength(2);
  expect(record.some((r) => r === "start:future")).toBe(false);
});

test("跑完回写 next_run_at 且释放 lease", async () => {
  const clock = new ManualClock(1_000_000);
  const store = new Store(":memory:", clock);
  store.insertAccountIfAbsent("tiktok", "a", 500_000);
  const sched = new Scheduler({ store, pipeline: fakePipeline([]), clock, platform: "tiktok", config: cfg });
  await sched.tick();
  const acc = store.getAccount("tiktok", "a")!;
  expect(acc.leaseUntil).toBeNull();
  expect(acc.nextRunAt).toBe(1_000_000 + 1_800_000); // 有新帖 → 30min
});

test("同账号不被同一 tick 重复领取", async () => {
  const clock = new ManualClock(1_000_000);
  const store = new Store(":memory:", clock);
  store.insertAccountIfAbsent("tiktok", "a", 500_000);
  const record: string[] = [];
  const sched = new Scheduler({ store, pipeline: fakePipeline(record), clock, platform: "tiktok", config: cfg });
  await Promise.all([sched.tick(), sched.tick()]);
  expect(record.filter((r) => r === "start:a")).toHaveLength(1);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/scheduler/scheduler.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现**

```ts
// src/scheduler/scheduler.ts
import type { Store } from "../store/store.ts";
import type { FetchPipeline } from "../pipeline/pipeline.ts";
import type { Clock } from "../clock.ts";
import type { AppConfig } from "../config.ts";
import { computeNextRunAt } from "../pipeline/nextRun.ts";

export interface SchedulerDeps {
  store: Store;
  pipeline: FetchPipeline;
  clock: Clock;
  platform: string;
  config: Pick<
    AppConfig,
    | "globalConcurrency"
    | "leaseBaselineMs"
    | "leaseHeartbeatMs"
    | "activeMinIntervalMs"
    | "idleIntervalMs"
    | "idleThresholdMs"
    | "activeMaxPosts"
  >;
}

export class Scheduler {
  private running = new Set<string>();
  constructor(private readonly d: SchedulerDeps) {}

  runningCount(): number {
    return this.running.size;
  }

  async tick(): Promise<number> {
    const remaining = this.d.config.globalConcurrency - this.running.size;
    if (remaining <= 0) return 0;
    const now = this.d.clock.now();
    const leased = this.d.store.leaseDueAccounts(
      this.d.platform,
      now,
      this.d.config.leaseBaselineMs,
      remaining,
    );
    await Promise.all(leased.map((acc) => this.runAccount(acc.accountId, acc.lastVideoId ?? undefined)));
    return leased.length;
  }

  async runAccount(accountId: string, lastVideoId?: string, activeMaxPosts?: number): Promise<void> {
    if (this.running.has(accountId)) return;
    this.running.add(accountId);
    const heartbeat = setInterval(() => {
      this.d.store.heartbeat(
        this.d.platform,
        accountId,
        this.d.clock.now() + this.d.config.leaseBaselineMs,
      );
    }, this.d.config.leaseHeartbeatMs);
    try {
      const res = await this.d.pipeline.run({ accountId, lastVideoId, activeMaxPosts });
      const acc = this.d.store.getAccount(this.d.platform, accountId);
      const nextRunAt = computeNextRunAt({
        now: this.d.clock.now(),
        hasNewPosts: res.newPosts > 0,
        lastPostAt: acc?.lastPostAt ?? res.latestPostAt,
        activeMinIntervalMs: this.d.config.activeMinIntervalMs,
        idleIntervalMs: this.d.config.idleIntervalMs,
        idleThresholdMs: this.d.config.idleThresholdMs,
      });
      this.d.store.setNextRunAt(this.d.platform, accountId, nextRunAt);
    } finally {
      clearInterval(heartbeat);
      this.d.store.releaseLease(this.d.platform, accountId);
      this.running.delete(accountId);
    }
  }
}
```

- [x] **Step 4: 补 Store.setNextRunAt(实现依赖)**

在 `src/store/store.ts` 追加(并在 `src/store/store.test.ts` 加一条断言):

```ts
  setNextRunAt(platform: string, accountId: string, nextRunAt: number): void {
    this.db.run("UPDATE accounts SET next_run_at=? WHERE platform=? AND account_id=?", [
      nextRunAt,
      platform,
      accountId,
    ]);
  }
```

测试(追加到 store.test.ts):

```ts
test("setNextRunAt 更新 next_run_at", () => {
  const store = new Store(":memory:", new ManualClock(0));
  store.insertAccountIfAbsent("tiktok", "u", 100);
  store.setNextRunAt("tiktok", "u", 777);
  expect(store.getAccount("tiktok", "u")!.nextRunAt).toBe(777);
  store.close();
});
```

- [x] **Step 5: 跑测试确认通过**

Run: `bun test src/scheduler/scheduler.test.ts src/store/store.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts src/store/store.ts src/store/store.test.ts
git commit -m "feat: implement Scheduler with concurrency, due lease, heartbeat and adaptive rerun"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 21: Scheduler — 退避帖子重拉旁路

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Test: `src/scheduler/scheduler.test.ts`(追加)

**Interfaces:**
- Consumes: `Store.dueFailedPosts`(Task 9)
- Produces:`Scheduler.tick` 扩展 —— 除领 due 账号外,还查 `dueFailedPosts`,按 accountId 分组,对到期失败帖子所属账号(且不在 running、能领到 lease)发起 `pipeline.run({accountId, onlyPostIds})` 直抓。退避帖子重拉仍占用并发额度(与设计"释放额度后重拉"一致:失败时已释放,重拉时重新占额度)。为避免与 due 账号重复,统一在一个候选集合里领取。

  实现:新增私有 `collectDueAccounts(now, remaining)`:先 `leaseDueAccounts`,若还有剩余额度,再对 `dueFailedPosts` 的 distinct accountId 逐个尝试 `leaseSpecificAccount`(见 Store 补充方法),领到的走 `runAccount(accountId, undefined, undefined, onlyPostIds)`。

- [x] **Step 1: 补 Store.leaseSpecificAccount(实现依赖)**

在 `src/store/store.ts` 追加,并在 store.test.ts 加断言:

```ts
  // 尝试领取指定账号(active 且 lease 可用),成功返回 true 并写 lease
  leaseSpecificAccount(platform: string, accountId: string, now: number, baselineMs: number): boolean {
    const txn = this.db.transaction(() => {
      const r = this.db
        .query(
          `SELECT 1 FROM accounts WHERE platform=? AND account_id=? AND active=1
             AND (lease_until IS NULL OR lease_until<=?)`,
        )
        .get(platform, accountId, now);
      if (!r) return false;
      this.db.run("UPDATE accounts SET lease_until=? WHERE platform=? AND account_id=?", [
        now + baselineMs,
        platform,
        accountId,
      ]);
      return true;
    });
    return txn() as boolean;
  }
```

store.test.ts:

```ts
test("leaseSpecificAccount 领取后再次领取失败", () => {
  const store = new Store(":memory:", new ManualClock(0));
  store.insertAccountIfAbsent("tiktok", "u", 0);
  expect(store.leaseSpecificAccount("tiktok", "u", 0, 300_000)).toBe(true);
  expect(store.leaseSpecificAccount("tiktok", "u", 1, 300_000)).toBe(false);
  store.close();
});
```

- [x] **Step 2: 写失败测试(追加到 scheduler.test.ts)**

```ts
test("到期失败帖子触发所属账号重拉(onlyPostIds 直抓)", async () => {
  const clock = new ManualClock(1_000_000);
  const store = new Store(":memory:", clock);
  store.insertAccountIfAbsent("tiktok", "a", 9_000_000); // 账号本身未到期
  store.markFailed("tiktok", "p1", 900_000);             // 失败帖已到期(<=now)
  const seen: any[] = [];
  const pipeline = {
    async run(req: any) {
      seen.push(req);
      return { newPosts: 0, latestPostAt: null, latestVideoId: null };
    },
  } as any;
  const sched = new Scheduler({ store, pipeline, clock, platform: "tiktok", config: cfg });
  await sched.tick();
  expect(seen).toHaveLength(1);
  expect(seen[0].accountId).toBe("a");
  expect(seen[0].onlyPostIds).toEqual(["p1"]);
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `bun test src/scheduler/scheduler.test.ts`
Expected: FAIL(重拉未实现)。

- [x] **Step 4: 实现(修改 tick)**

```ts
  async tick(): Promise<number> {
    let remaining = this.d.config.globalConcurrency - this.running.size;
    if (remaining <= 0) return 0;
    const now = this.d.clock.now();

    const leased = this.d.store.leaseDueAccounts(
      this.d.platform,
      now,
      this.d.config.leaseBaselineMs,
      remaining,
    );
    const jobs: Promise<void>[] = leased.map((acc) =>
      this.runAccount(acc.accountId, acc.lastVideoId ?? undefined),
    );
    remaining -= leased.length;
    const leasedIds = new Set(leased.map((a) => a.accountId));

    if (remaining > 0) {
      const due = this.d.store.dueFailedPosts(this.d.platform, now);
      const byAccount = new Map<string, string[]>();
      for (const f of due) {
        // 失败记录不含 accountId;需通过 fetched_posts→? 关联。见实现说明。
      }
      // 见 Step 5 的实现说明:dueFailedPosts 需返回 accountId
      for (const [accountId, postIds] of byAccount) {
        if (remaining <= 0) break;
        if (leasedIds.has(accountId) || this.running.has(accountId)) continue;
        if (this.d.store.leaseSpecificAccount(accountId, ...)) { /* ... */ }
      }
    }
    await Promise.all(jobs);
    return jobs.length;
  }
```

- [x] **Step 5: 实现说明 —— 让退避帖子能定位账号**

`fetched_posts` 无 `account_id` 列(设计只存最小状态)。为支持重拉需知道失败帖属于哪个账号。两种方案,选**方案 A**(改 `dueFailedPosts` 关联):失败帖的 accountId 可由 `fetched_posts` 加一列 `account_id` 承载(仍是最小调度状态,不算帖子全量信息)。据此:

1. 在 `src/store/schema.ts` 的 `fetched_posts` 增列 `account_id TEXT`。
2. `markSuccess`/`markFailed` 增参数 `accountId`,写入该列。**这会改签名**——同步更新 Task 6/9 的调用点(pipeline.recordFailure、pipeline.markSuccess 调用)与其测试。
3. `dueFailedPosts` 返回值 `FailedPost` 增字段 `accountId`。
4. 回到 tick:`byAccount` 按 `f.accountId` 分组;`leaseSpecificAccount(platform, accountId, now, baselineMs)` 领取成功则 `jobs.push(this.runAccount(accountId, undefined, undefined, postIds))`,`remaining--`。

> 执行者注意:此为跨任务签名变更。落地顺序 = 先改 schema+Store(markSuccess/markFailed/dueFailedPosts/FailedPost 加 accountId)并更新 Task 6/9 测试 → 再改 pipeline 调用点与测试 → 最后完成本 tick 重拉逻辑。`runAccount` 增加第 4 参 `onlyPostIds?: string[]`,透传给 `pipeline.run`。

- [x] **Step 6: 跑全部相关测试确认通过**

Run: `bun test src/scheduler/ src/store/ src/pipeline/`
Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add src/store/schema.ts src/store/store.ts src/store/store.test.ts src/pipeline/pipeline.ts src/pipeline/pipeline.test.ts src/scheduler/scheduler.ts src/scheduler/scheduler.test.ts
git commit -m "feat: repull due failed posts by owning account without occupying idle slot"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 22: AccountListSource 与 Reconciler 循环

**Files:**
- Create: `src/accounts/listSource.ts`
- Create: `src/accounts/reconciler.ts`
- Test: `src/accounts/listSource.test.ts`
- Test: `src/accounts/reconciler.test.ts`

**Interfaces:**
- Consumes: `Store.reconcile`(Task 8)、`Clock`
- Produces:
  ```ts
  // listSource.ts
  export interface AccountListSource { fetchAccountIds(): Promise<string[]>; }
  export class HttpAccountListSource implements AccountListSource {
    constructor(url: string, fetchImpl?: typeof fetch);
    fetchAccountIds(): Promise<string[]>; // GET url → JSON string[](或 {accounts:string[]})
  }
  // reconciler.ts
  export interface ReconcilerDeps {
    source: AccountListSource; store: Store; clock: Clock; platform: string;
    jitterMaxMs?: number; rand?: () => number;
  }
  export class Reconciler {
    constructor(deps: ReconcilerDeps);
    reconcileOnce(): Promise<void>; // 拉名单→store.reconcile;拉取失败则跳过(不清空)
  }
  ```

- [x] **Step 1: 写失败测试(listSource)**

```ts
// src/accounts/listSource.test.ts
import { test, expect } from "bun:test";
import { HttpAccountListSource } from "./listSource.ts";

test("解析 JSON 数组", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify(["a", "b"]), { status: 200 })) as any;
  const src = new HttpAccountListSource("http://list", fakeFetch);
  expect(await src.fetchAccountIds()).toEqual(["a", "b"]);
});

test("解析 {accounts:[...]} 形态", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ accounts: ["x"] }), { status: 200 })) as any;
  const src = new HttpAccountListSource("http://list", fakeFetch);
  expect(await src.fetchAccountIds()).toEqual(["x"]);
});

test("非 2xx 抛错", async () => {
  const fakeFetch = (async () => new Response("", { status: 500 })) as any;
  const src = new HttpAccountListSource("http://list", fakeFetch);
  await expect(src.fetchAccountIds()).rejects.toThrow();
});
```

- [x] **Step 2: 写失败测试(reconciler)**

```ts
// src/accounts/reconciler.test.ts
import { test, expect } from "bun:test";
import { Reconciler } from "./reconciler.ts";
import { Store } from "../store/store.ts";
import { ManualClock } from "../clock.ts";

test("reconcileOnce 新增账号并进入调度", async () => {
  const clock = new ManualClock(1000);
  const store = new Store(":memory:", clock);
  const source = { async fetchAccountIds() { return ["a", "b"]; } };
  const r = new Reconciler({ source, store, clock, platform: "tiktok", jitterMaxMs: 0, rand: () => 0 });
  await r.reconcileOnce();
  expect(store.getAccount("tiktok", "a")!.active).toBe(true);
  expect(store.getAccount("tiktok", "a")!.nextRunAt).toBe(1000);
});

test("拉取失败时保留现有名单不清空", async () => {
  const clock = new ManualClock(1000);
  const store = new Store(":memory:", clock);
  store.insertAccountIfAbsent("tiktok", "keep", 100);
  const source = { async fetchAccountIds(): Promise<string[]> { throw new Error("net down"); } };
  const r = new Reconciler({ source, store, clock, platform: "tiktok" });
  await r.reconcileOnce(); // 不应抛出到调用方,内部吞掉并保留
  expect(store.getAccount("tiktok", "keep")!.active).toBe(true);
});
```

- [x] **Step 3: 跑测试确认失败**

Run: `bun test src/accounts/`
Expected: FAIL(模块不存在)。

- [x] **Step 4: 实现 listSource**

```ts
// src/accounts/listSource.ts
export interface AccountListSource {
  fetchAccountIds(): Promise<string[]>;
}

export class HttpAccountListSource implements AccountListSource {
  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async fetchAccountIds(): Promise<string[]> {
    const res = await this.fetchImpl(this.url);
    if (!res.ok) throw new Error(`账号名单接口失败: HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) return data.map(String);
    if (data && typeof data === "object" && Array.isArray((data as any).accounts)) {
      return (data as any).accounts.map(String);
    }
    throw new Error("账号名单格式无法识别");
  }
}
```

- [x] **Step 5: 实现 reconciler**

```ts
// src/accounts/reconciler.ts
import type { AccountListSource } from "./listSource.ts";
import type { Store } from "../store/store.ts";
import type { Clock } from "../clock.ts";

export interface ReconcilerDeps {
  source: AccountListSource;
  store: Store;
  clock: Clock;
  platform: string;
  jitterMaxMs?: number;
  rand?: () => number;
}

export class Reconciler {
  constructor(private readonly d: ReconcilerDeps) {}

  async reconcileOnce(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.d.source.fetchAccountIds();
    } catch (err) {
      console.error("reconcile 拉取名单失败,保留现有名单:", (err as Error).message);
      return;
    }
    const jitterMax = this.d.jitterMaxMs ?? 0;
    const rand = this.d.rand ?? Math.random;
    this.d.store.reconcile(this.d.platform, ids, this.d.clock.now(), () =>
      Math.round(jitterMax * rand()),
    );
  }
}
```

- [x] **Step 6: 跑测试确认通过**

Run: `bun test src/accounts/`
Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add src/accounts/listSource.ts src/accounts/reconciler.ts src/accounts/listSource.test.ts src/accounts/reconciler.test.ts
git commit -m "feat: add account list source and reconciler with failure-safe upsert"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 23: HTTP — POST /fetch(异步 202 + 即时插入账号)

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`(追加)

**Interfaces:**
- Consumes: `Store.insertAccountIfAbsent`(Task 6)、`Scheduler`(Task 20)、`Clock`
- Produces:扩展 `ServerDeps`:
  ```ts
  export interface ServerDeps {
    store?: Store;
    clock?: Clock;
    enqueueActive?: (accountId: string) => void; // 由装配层注入:置 next_run_at=now、标记主动(activeMaxPosts=100)并触发领取
    statusProvider?: () => unknown;              // Task 24
    platform?: string;
  }
  ```
  `POST /fetch` body `{ accountId: string }`:
  1. 账号不存在 → `store.insertAccountIfAbsent(platform, accountId, now)`(active=1);
  2. `store.setNextRunAt(platform, accountId, now)`(置为尽快);
  3. `enqueueActive(accountId)`(异步触发,不 await 抓取完成);
  4. 立即返回 `202 { accepted: true, accountId }`。

- [x] **Step 1: 写失败测试(追加)**

```ts
import { Store } from "./store/store.ts";
import { ManualClock } from "./clock.ts";

test("POST /fetch 返回 202 并即时插入不存在的账号", async () => {
  const clock = new ManualClock(1000);
  const store = new Store(":memory:", clock);
  const enqueued: string[] = [];
  const app = createServer({
    store,
    clock,
    platform: "tiktok",
    enqueueActive: (id) => enqueued.push(id),
  });
  const res = await app.handle(
    new Request("http://localhost/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "newbie" }),
    }),
  );
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ accepted: true, accountId: "newbie" });
  const acc = store.getAccount("tiktok", "newbie")!;
  expect(acc.active).toBe(true);
  expect(acc.nextRunAt).toBe(1000);
  expect(enqueued).toEqual(["newbie"]);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/server.test.ts`
Expected: FAIL(路由不存在)。

- [x] **Step 3: 实现(扩展 createServer)**

```ts
// src/server.ts
import { Elysia } from "elysia";
import type { Store } from "./store/store.ts";
import type { Clock } from "./clock.ts";

export interface ServerDeps {
  store?: Store;
  clock?: Clock;
  platform?: string;
  enqueueActive?: (accountId: string) => void;
  statusProvider?: () => unknown;
}

export function createServer(deps: ServerDeps): Elysia {
  const platform = deps.platform ?? "tiktok";
  const app = new Elysia().get("/health", () => ({ ok: true }));

  app.post("/fetch", ({ body, set }) => {
    const accountId = (body as { accountId?: string })?.accountId;
    if (!accountId) {
      set.status = 400;
      return { error: "accountId required" };
    }
    if (deps.store && deps.clock) {
      const now = deps.clock.now();
      deps.store.insertAccountIfAbsent(platform, accountId, now);
      deps.store.setNextRunAt(platform, accountId, now);
    }
    deps.enqueueActive?.(accountId);
    set.status = 202;
    return { accepted: true, accountId };
  });

  return app;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/server.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add POST /fetch async 202 with just-in-time account insert"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 24: HTTP — GET /status 与 GET /health 明细

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`(追加)

**Interfaces:**
- Consumes: `statusProvider`(Task 23 的 `ServerDeps`)
- Produces:`GET /status` 返回 `statusProvider()` 的结果(装配层提供:在跑账号、各账号 next_run_at、失败重试队列等)。缺省时返回 `{ running: [], accounts: [] }`。

- [x] **Step 1: 写失败测试(追加)**

```ts
test("GET /status 返回 statusProvider 结果", async () => {
  const app = createServer({
    statusProvider: () => ({ running: ["a"], backlog: 3 }),
  });
  const res = await app.handle(new Request("http://localhost/status"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ running: ["a"], backlog: 3 });
});

test("GET /status 无 provider 时返回空结构", async () => {
  const app = createServer({});
  const res = await app.handle(new Request("http://localhost/status"));
  expect(await res.json()).toEqual({ running: [], accounts: [] });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/server.test.ts`
Expected: FAIL(/status 不存在)。

- [x] **Step 3: 实现(在 createServer 追加路由)**

```ts
  app.get("/status", () => deps.statusProvider?.() ?? { running: [], accounts: [] });
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test src/server.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add src/server.ts src/server.test.ts
git commit -m "feat: add GET /status observability endpoint"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 25: 服务装配与启动循环(index.ts 重写为服务入口)

**Files:**
- Modify: `src/index.ts`(重写为服务入口)
- Create: `src/app.ts`(装配纯函数,便于测试)
- Test: `src/app.test.ts`

**Interfaces:**
- Consumes: 全部前述模块 + `ensureYtDlp`(既有 `src/ytdlp-manager/ytDlpManager.ts`)
- Produces:
  ```ts
  // app.ts —— 纯装配,不监听端口/不起真定时器(定时器由 index.ts 用 SystemClock 起)
  export interface App {
    server: import("elysia").Elysia;
    scheduler: Scheduler;
    reconciler: Reconciler;
    tickOnce(): Promise<number>;
    reconcileOnce(): Promise<void>;
  }
  export function buildApp(cfg: AppConfig, clock: Clock, runner: ProcessRunner): App;
  ```
  `buildApp` 装配 Store、TikTokAdapter、CosUploader(`createCosClient`)、CallbackSink(有 `instarCallbackUrl` 用 Http 否则 Noop)、FetchPipeline、Scheduler、HttpAccountListSource、Reconciler,并用 `createServer` 挂 `enqueueActive=(id)=>scheduler.runAccount(id, undefined, cfg.activeMaxPosts)`、`statusProvider`。`index.ts`:加载 config → `ensureYtDlp` → `new YtDlpRunner` → `buildApp(cfg, new SystemClock(), runner)` → `app.server.listen(port)` → `setInterval(tickOnce, cfg.scheduleTickMs)` + `setInterval(reconcileOnce, cfg.reconcileMs)`。

- [x] **Step 1: 写失败测试(装配冒烟,注入 fake runner + ManualClock + :memory:)**

```ts
// src/app.test.ts
import { test, expect } from "bun:test";
import { buildApp } from "./app.ts";
import { ManualClock } from "./clock.ts";
import type { AppConfig } from "./config.ts";
import type { ProcessRunner } from "./types.ts";

const cfg: AppConfig = {
  globalConcurrency: 2, scheduleTickMs: 60_000, reconcileMs: 300_000,
  leaseBaselineMs: 300_000, leaseHeartbeatMs: 120_000, fetchDelayMinMs: 0, fetchDelayMaxMs: 0,
  postTimeoutMs: 300_000, retryBackoffMs: [60_000, 180_000, 600_000], retryMax: 3,
  activeMinIntervalMs: 1_800_000, idleIntervalMs: 21_600_000, idleThresholdMs: 86_400_000,
  activeMaxPosts: 100, accountListUrl: "http://list", sqlitePath: ":memory:",
  cos: { bucket: "b", region: "r", secretId: "i", secretKey: "k" },
};

const runner: ProcessRunner = {
  async run() { return { code: 0, stdout: JSON.stringify({ entries: [] }), stderr: "" }; },
  runStream() { throw new Error("not used"); },
};

test("buildApp 装配出可响应 /health 的服务", async () => {
  const app = buildApp(cfg, new ManualClock(0), runner);
  const res = await app.server.handle(new Request("http://localhost/health"));
  expect(await res.json()).toEqual({ ok: true });
});

test("tickOnce 在无账号时返回 0", async () => {
  const app = buildApp(cfg, new ManualClock(0), runner);
  expect(await app.tickOnce()).toBe(0);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test src/app.test.ts`
Expected: FAIL(模块不存在)。

- [x] **Step 3: 实现 app.ts**

```ts
// src/app.ts
import type { Elysia } from "elysia";
import type { AppConfig } from "./config.ts";
import type { Clock } from "./clock.ts";
import type { ProcessRunner } from "./types.ts";
import { Store } from "./store/store.ts";
import { TikTokAdapter } from "./platform/tiktok/adapter.ts";
import { CosUploader, createCosClient } from "./pipeline/uploader.ts";
import { NoopCallbackSink, HttpCallbackSink, type CallbackSink } from "./pipeline/callbackSink.ts";
import { FetchPipeline } from "./pipeline/pipeline.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { HttpAccountListSource } from "./accounts/listSource.ts";
import { Reconciler } from "./accounts/reconciler.ts";
import { createServer } from "./server.ts";

export interface App {
  server: Elysia;
  scheduler: Scheduler;
  reconciler: Reconciler;
  tickOnce(): Promise<number>;
  reconcileOnce(): Promise<void>;
}

export function buildApp(cfg: AppConfig, clock: Clock, runner: ProcessRunner): App {
  const platform = "tiktok";
  const store = new Store(cfg.sqlitePath, clock);
  const adapter = new TikTokAdapter(runner, { proxy: cfg.proxy });
  const uploader = new CosUploader(createCosClient(cfg.cos), {
    bucket: cfg.cos.bucket,
    region: cfg.cos.region,
  });
  const sink: CallbackSink = cfg.instarCallbackUrl
    ? new HttpCallbackSink(cfg.instarCallbackUrl)
    : new NoopCallbackSink();
  const pipeline = new FetchPipeline({
    adapter,
    uploader,
    sink,
    store,
    clock,
    postTimeoutMs: cfg.postTimeoutMs,
    fetchDelayMinMs: cfg.fetchDelayMinMs,
    fetchDelayMaxMs: cfg.fetchDelayMaxMs,
    retryBackoffMs: cfg.retryBackoffMs,
    retryMax: cfg.retryMax,
  });
  const scheduler = new Scheduler({ store, pipeline, clock, platform, config: cfg });
  const source = new HttpAccountListSource(cfg.accountListUrl);
  const reconciler = new Reconciler({ source, store, clock, platform, jitterMaxMs: cfg.scheduleTickMs });

  const server = createServer({
    store,
    clock,
    platform,
    enqueueActive: (id) => {
      void scheduler.runAccount(id, undefined, cfg.activeMaxPosts);
    },
    statusProvider: () => ({
      running: scheduler.runningCount(),
      accounts: store.listAccountIds(platform),
    }),
  });

  return {
    server,
    scheduler,
    reconciler,
    tickOnce: () => scheduler.tick(),
    reconcileOnce: () => reconciler.reconcileOnce(),
  };
}
```

- [x] **Step 4: 重写 index.ts 为服务入口**

```ts
// src/index.ts
import { loadConfig } from "./config.ts";
import { SystemClock } from "./clock.ts";
import { YtDlpRunner } from "./ytdlp-manager/runner.ts";
import { ensureYtDlp } from "./ytdlp-manager/ytDlpManager.ts";
import { buildApp } from "./app.ts";

export async function main(): Promise<void> {
  const cfg = loadConfig(process.env);
  const ytDlp = await ensureYtDlp({ toolDir: process.env.YT_DLP_TOOL_DIR });
  const runner = new YtDlpRunner(ytDlp.currentPath);
  const app = buildApp(cfg, new SystemClock(), runner);

  const port = Number(process.env.PORT ?? 3000);
  app.server.listen(port);
  console.log(`tiktok-download-worker 监听 :${port}`);

  setInterval(() => {
    app.tickOnce().catch((err) => console.error("tick 失败:", err));
  }, cfg.scheduleTickMs);
  setInterval(() => {
    app.reconcileOnce().catch((err) => console.error("reconcile 失败:", err));
  }, cfg.reconcileMs);

  // 启动即先对账一次,填充账号名单
  app.reconcileOnce().catch((err) => console.error("首轮 reconcile 失败:", err));
}

if (import.meta.main) {
  await main();
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `bun test src/app.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add src/app.ts src/app.test.ts src/index.ts
git commit -m "feat: wire service assembly and rewrite index.ts as resident worker entry"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 26: 移除 CLI 主入口与废弃模块

**Files:**
- Delete: `src/parsing/parser.ts`、`src/parsing/parser.test.ts`
- Delete: `src/scheduling/scheduler.ts`、`src/scheduling/scheduler.test.ts`、`src/scheduling/task.ts`、`src/scheduling/task.test.ts`
- Delete: `src/upload/uploader.ts`、`src/upload/uploader.test.ts`
- Delete: `src/ytdlp-manager/worker.ts`(若存在)、`src/cli.test.ts`
- Modify: `src/types.ts`(移除 CLI 专用 `Config`、旧 `Uploader(filePath)`、`Task`/`VideoInfo`/`DownloadResult`/`Summary` 中仅 CLI 用的;保留 `ProcessResult`/`ProcessStream`/`ProcessRunner`)
- Delete: `test.ts`(仓库根的 COS 手验脚本,已被 CosUploader 取代)

**Interfaces:**
- Consumes: 无
- Produces:无新增。目标:全仓无对已删除模块的 import,`bun test` 与类型检查全绿。

- [x] **Step 1: 确认无外部引用后删除**

Run: `bun run grep-check`(或用 grep 工具)确认无 `from "./parsing`、`from "./scheduling`、`from "./upload/uploader`、`ytdlp-manager/worker`、`from "../types"` 中对已删类型的引用残留。命令:

```bash
grep -rn "parsing/parser\|scheduling/\|upload/uploader\|ytdlp-manager/worker" src || echo "no refs"
```
Expected: 仅剩本任务将删除的文件自身(或 `no refs`)。

- [x] **Step 2: 删除文件**

```bash
git rm src/parsing/parser.ts src/parsing/parser.test.ts \
       src/scheduling/scheduler.ts src/scheduling/scheduler.test.ts \
       src/scheduling/task.ts src/scheduling/task.test.ts \
       src/upload/uploader.ts src/upload/uploader.test.ts \
       src/cli.test.ts test.ts
git rm src/ytdlp-manager/worker.ts 2>/dev/null || true
```

- [x] **Step 3: 清理 types.ts**

将 `src/types.ts` 精简为仅服务侧仍用的类型:

```ts
import type { Readable } from "node:stream";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessStream {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
  kill?: () => void;
}

export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
  runStream(args: string[]): ProcessStream;
}
```

- [x] **Step 4: 跑全量测试与类型检查**

Run: `bun test && bunx tsc --noEmit`
Expected: 全部 PASS,无类型错误,无对已删模块的引用。

- [x] **Step 5: 提交**

```bash
git add -A
git commit -m "refactor: remove CLI entrypoint and obsolete parsing/scheduling/upload modules"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 27: 关键场景集成测试补全

**Files:**
- Create: `src/integration.test.ts`

**Interfaces:**
- Consumes: `buildApp` 或直接组合 `Scheduler + FetchPipeline + Store + fake adapter + ManualClock`
- Produces:覆盖 delta spec 中尚未被单测直接覆盖的端到端场景(用 fake adapter + ManualClock + `:memory:`,不碰网络/yt-dlp):

  1. **发布时间升序处理**:多帖乱序 publishedAt,断言 `sink.send`/`markSuccess` 调用顺序与游标推进按从旧到新。
  2. **发布时间缺失估算不丢弃**:`cleanse` 产出 `publishedEst=true` 的帖仍被抓取上传(newPosts 计入)。
  3. **退避后成功**:首次失败(exit≠0)→ `advance` 到退避到期 → tick 重拉 → 第二次成功 → 最终 `isFetched=true`。
  4. **重试耗尽最终失败**:连续失败 4 次后 `dueFailedPosts` 为空且 `isFetched=false`。
  5. **主动 100 条上限 + 去重**:listPosts 返回 150 条、其中若干已 success,主动 `runAccount(id, undefined, 100)` 只处理最近 100 条里未 success 的。
  6. **主动触发与定时互斥**:同账号并发 `tick()` 与 `runAccount()` 只跑一次。
  7. **重启保留**:临时文件 Store 写 success 后新建 Store 仍去重。

- [x] **Step 1: 写这些集成测试(先全部失败/占位)**

按上述 7 项,每项一个 `test(...)`,复用前面任务里的 fake adapter 模式与 `ManualClock`。示例(升序处理):

```ts
// src/integration.test.ts
import { test, expect } from "bun:test";
import { Store } from "./store/store.ts";
import { ManualClock } from "./clock.ts";
import { FetchPipeline } from "./pipeline/pipeline.ts";
import { NoopCallbackSink } from "./pipeline/callbackSink.ts";
import { Readable } from "node:stream";
import type { PlatformAdapter, Post, PostRef, MediaStream } from "./platform/adapter.ts";
import type { Uploader } from "./pipeline/uploader.ts";

function adapterWithTimes(times: Record<string, number>): PlatformAdapter {
  const ids = Object.keys(times);
  return {
    platform: "tiktok",
    async listPosts() {
      // 倒序(最新在前):按 publishedAt 降序
      return ids
        .sort((a, b) => times[b]! - times[a]!)
        .map((id, i): PostRef => ({ platform: "tiktok", id, accountId: "u", url: `http://x/${id}`, listIndex: i }));
    },
    async fetchDetail(ref: PostRef) { return { id: ref.id }; },
    cleanse(ref: PostRef): Post {
      return { platform: "tiktok", id: ref.id, accountId: "u", url: ref.url, publishedAt: times[ref.id]!, publishedEst: false };
    },
    openMediaStream(): MediaStream {
      return { stream: Readable.from(["x"]), exited: Promise.resolve(0), abort() {} };
    },
  };
}

test("按发布时间从旧到新处理", async () => {
  const clock = new ManualClock(1000);
  const store = new Store(":memory:", clock);
  const order: string[] = [];
  const sink: any = { async send(p: Post) { order.push(p.id); } };
  const uploader: Uploader = { async upload() {} };
  const pipe = new FetchPipeline({
    adapter: adapterWithTimes({ old: 100, mid: 200, new: 300 }),
    uploader, sink, store, clock,
    postTimeoutMs: 300_000, fetchDelayMinMs: 0, fetchDelayMaxMs: 0,
    retryBackoffMs: [60_000, 180_000, 600_000], retryMax: 3, rand: () => 0,
  });
  await pipe.run({ accountId: "u" });
  expect(order).toEqual(["old", "mid", "new"]);
});
```

其余 6 项按同模式补全(每项独立 test,断言对应 spec 场景)。

- [x] **Step 2: 跑测试,逐项修正到通过**

Run: `bun test src/integration.test.ts`
Expected: 全部 PASS。若某项失败,用 systematic-debugging 定位(多为 fake adapter 顺序或 ManualClock advance 时机),修正测试或回填被测实现缺口。

- [x] **Step 3: 跑全量回归**

Run: `bun test`
Expected: 全绿。

- [x] **Step 4: 提交**

```bash
git add src/integration.test.ts
git commit -m "test: cover ordering, backoff, active-limit, mutual-exclusion, persistence scenarios"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

### Task 28: 更新 README / 部署说明(挂载 SQLite volume)

**Files:**
- Modify: `README.md`(无则 Create)

**Interfaces:**
- Consumes: 无
- Produces:文档说明服务运行方式与部署约束。

- [x] **Step 1: 写/更新 README**

内容至少包含:
- 服务简介(常驻 Elysia worker,替换旧 CLI)。
- 运行:`bun run src/index.ts`(或 `bun start`),监听 `PORT`(默认 3000)。
- HTTP 接口:`POST /fetch {accountId}` → 202;`GET /status`;`GET /health`。
- 全部环境变量表(照搬 Design Doc 配置表,标必填:`ACCOUNT_LIST_URL`、`COS_*`)。
- **Docker 部署必须挂载 SQLite 持久化目录**:`SQLITE_PATH` 指向挂载卷(如 `/data/worker.sqlite`),示例 `docker run -v tiktok-data:/data -e SQLITE_PATH=/data/worker.sqlite ...`;强调不挂载会导致重启丢去重/游标。

- [x] **Step 2: 校验文档内的命令可用**

Run: `bun run src/index.ts`(设置最小必填 env,确认能启动并响应 `GET /health`;确认后 Ctrl-C)。或仅 `bun test` 保证不回归(文档任务无代码变更时)。
Expected: 服务启动日志出现监听端口;`curl localhost:3000/health` 返回 `{"ok":true}`(手动可选)。

- [x] **Step 3: 提交**

```bash
git add README.md
git commit -m "docs: document worker service, endpoints, env vars and sqlite volume mount"
```

archived-with: 2026-07-04-serve-tiktok-download-worker
---

## Self-Review

**1. Spec coverage(delta spec → task):**

- tiktok-fetch-pipeline:平台适配器抽象=Task 4/10-12;列表与详情两段抓取=Task 10/11/17;按发布时间从远及近(含缺失估算)=Task 11/17/19/27;数据清洗=Task 11;视频流直传 COS(含超时中止、默认 key)=Task 12/13/14/18;失败重试指数退避=Task 9/18/21/27;成功后回传(含失败不回滚)=Task 15/18/27。✓
- tiktok-fetch-service:Elysia 常驻=Task 1/25;主动 100 条上限(异步 202、本地不存在即时插入)=Task 17/23/27;SQLite 持久化去重与游标(重启保留)=Task 5/6/27;并发限制与同账号串行(占用防重复、崩溃重领)=Task 7/20/27;yt-dlp 调用随机延迟=Task 16/18;可配置周期与积压治理=Task 2/20;due 驱动调度=Task 20;活跃度自适应频率=Task 19/20;外部账号名单对账=Task 8/22。✓
- tiktok-download-scheduler(MODIFIED):任务建模与状态持久化=Task 5/6/9;并发执行=Task 20;失败重试=Task 18/21;下载成功后上传=Task 14/18。REMOVED(解析列表/代理/worker池)=Task 26 删除对应 CLI 模块;代理改配置=Task 2/10-12 透传。✓
- tasks.md 七组:1=Task 1/2/25;2=Task 5/6;3=Task 4/10-12;4=Task 17/13/14/15/18;5=Task 20/21/16/22/19/23;6=Task 23/24/22;7=Task 27/28。✓

**2. Placeholder scan:** 每个代码步骤均含完整代码;Task 18/21 存在跨任务签名变更(recordFailure 退避档位、fetched_posts 增 account_id 列),已在 Step 说明中给出精确落地顺序与受影响调用点,非占位。Task 27 的其余 6 项测试给了模式与首个完整样例,执行者按同模式补全。

**3. Type consistency:** `Post`/`PostRef`/`MediaStream`(Task 4)贯穿 adapter/pipeline/cosKey/callbackSink;`Uploader.upload(stream,key,signal)`(Task 14)与 pipeline 调用一致;`Store` 方法签名(getAccount/isFetched/markSuccess/markFailed/getAttempts/dueFailedPosts/leaseDueAccounts/heartbeat/releaseLease/reconcile/setNextRunAt/insertAccountIfAbsent/leaseSpecificAccount/advanceCursor/listAccountIds/setActive)在 Store 任务定义、被 pipeline/scheduler/reconciler/server 一致引用;`Clock.now/sleep` + `ManualClock.advance` 全程一致;`AppConfig` 字段名在 config/pipeline/scheduler/app 一致。

> 已知需执行者留意的一致性风险:Task 6 `markSuccess`、Task 9 `markFailed`/`FailedPost` 在 Task 21 追加 `accountId` 维度。执行 Task 21 时务必回改这两处签名与其单测(Step 5 已列顺序),保证 scheduler 重拉能定位账号。
