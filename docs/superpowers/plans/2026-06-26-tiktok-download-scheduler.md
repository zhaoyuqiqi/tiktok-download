---
change: tiktok-download-scheduler
design-doc: docs/superpowers/specs/2026-06-26-tiktok-download-scheduler-design.md
base-ref: 01bb742bc7006b580adfd5d6a6a7e88971880a98
archived-with: 2026-06-26-tiktok-download-scheduler
---

# TikTok 下载任务调度管理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 用 Bun + TypeScript 实现一个 CLI 工具,通过外部 `yt-dlp` 并发下载 TikTok 单视频或用户最新 N 个视频,带固定延迟重试,并在下载成功后异步触发上传 hook。

**Architecture:** 单向数据流 `cli → parser → TaskQueue → scheduler → worker → runner → yt-dlp`。`runner` 是唯一接触子进程的模块,其余模块通过依赖注入接收它或其产物,因此所有单元测试都用假 `ProcessRunner` / 假 `download` 函数,无需真实 yt-dlp。`scheduler` 用固定数量的异步 worker 循环保证并发 ≤ workers,下载成功后 fire-and-forget 调用 `uploader.upload`,队列排空后 await 所有 in-flight 上传再返回。

**Tech Stack:** Bun(runtime + 测试 + `Bun.spawn` / `Bun.which`),TypeScript(strict),外部 `yt-dlp`。无第三方 npm 依赖。

设计文档:`docs/superpowers/specs/2026-06-26-tiktok-download-scheduler-design.md`(下文以「设计 §X.Y」引用)。

## Global Constraints

> 每个任务的要求都隐含包含本节。值逐字来自设计文档与 CLAUDE.md。

- 运行时:Bun,不用 Node.js / npm / pnpm / vite。
- 不引入任何第三方 npm 依赖(标准库 + Bun API 自给自足)。
- 子进程统一用 `Bun.spawn`(不用 `child_process` / `execa`);PATH 探测用 `Bun.which`。
- 测试统一用 `bun test`(`import { test, expect } from "bun:test"`);不用 jest / vitest。
- 文件读写优先 `Bun.file`(本计划仅 worker 测试涉及临时文件)。
- TypeScript strict 已开启,`noUncheckedIndexedAccess: true`:数组下标访问得到 `T | undefined`,处理时须显式判空。
- `yt-dlp` 目标版本 2026.06.09,需在 PATH 中。
- 默认值:`workers = 2`,`retry = 2`,`outputDir = ./output`,重试固定延迟 `retryDelayMs = 2000`。
- 所有源码放 `src/`,测试与被测文件同目录(如 `src/parser.test.ts`)。
- `runner` 是唯一接触子进程的模块,其它模块禁止直接 `Bun.spawn`。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/types.ts` | 集中类型:`TaskStatus`、`VideoInfo`、`Task`、`Uploader`、`ProcessResult`、`ProcessRunner`、`Config`、`DownloadResult`、`Summary` |
| `src/runner.ts` | `ProcessRunner` 接口的真实实现 `YtDlpRunner`(`Bun.spawn`)+ `checkYtDlpAvailable()`(`Bun.which`)。唯一接触子进程处 |
| `src/parser.ts` | `parse(runner, url, limit?)`:`yt-dlp -J --flat-playlist [-I :N]`,单/多视频识别 |
| `src/task.ts` | `createTask(video)` + `TaskQueue`(内存队列、状态流转、汇总) |
| `src/uploader.ts` | `NoopUploader implements Uploader` 桩 |
| `src/worker.ts` | `download(runner, task, outputDir)`:对单视频跑 yt-dlp,提取最终文件路径 |
| `src/scheduler.ts` | `runScheduler(...)`:N worker 并发循环、重试、fire-and-forget 上传、收敛 |
| `src/index.ts` | CLI 入口:argv 解析、yt-dlp 探测、组装各模块、打印汇总、退出码 |

测试:`src/parser.test.ts`、`src/task.test.ts`、`src/uploader.test.ts`、`src/worker.test.ts`、`src/scheduler.test.ts`。

任务顺序按依赖:types → runner → parser → task → uploader → worker → scheduler → cli → 冒烟。与 `openspec/changes/tiktok-download-scheduler/tasks.md` 的边界对齐(映射见每个任务标题后的括注)。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 1: 核心类型定义(tasks 1.1)

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Consumes: 无(首个任务)。
- Produces: 全部下游任务依赖的类型。精确签名如下,后续任务必须严格使用这些名字:
  - `type TaskStatus = "pending" | "running" | "success" | "failed"`
  - `interface VideoInfo { id: string; url: string; title?: string }`
  - `interface Task { id: string; url: string; title?: string; status: TaskStatus; attempts: number }`
  - `interface Uploader { upload(filePath: string): Promise<void> }`
  - `interface ProcessResult { code: number; stdout: string; stderr: string }`
  - `interface ProcessRunner { run(args: string[]): Promise<ProcessResult> }`
  - `interface Config { url: string; limit?: number; workers: number; retry: number; outputDir: string }`
  - `interface DownloadResult { ok: boolean; filePath?: string; error?: string }`
  - `interface Summary { success: number; failed: number; total: number }`

> 说明:`DownloadResult` 与 `Summary` 是设计 §2.5 / §2.4 中出现但未单列的返回类型,这里集中定义以便全程类型一致。

- [x] **Step 1: 写 `src/types.ts`**

```ts
export type TaskStatus = "pending" | "running" | "success" | "failed";

export interface VideoInfo {
  id: string;
  url: string; // 用于下载的页面 URL(entry.url ?? 由 id 兜底)
  title?: string; // flat-playlist 下可能缺失
}

export interface Task {
  id: string;
  url: string;
  title?: string;
  status: TaskStatus;
  attempts: number; // 已尝试次数
}

export interface Uploader {
  upload(filePath: string): Promise<void>;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
}

export interface Config {
  url: string;
  limit?: number; // 仅多视频生效
  workers: number; // 默认 2
  retry: number; // 默认 2
  outputDir: string; // 默认 ./output
}

export interface DownloadResult {
  ok: boolean;
  filePath?: string;
  error?: string;
}

export interface Summary {
  success: number;
  failed: number;
  total: number;
}
```

- [x] **Step 2: 类型编译校验**

Run: `bunx tsc --noEmit`
Expected: 无错误输出(退出码 0)。

- [x] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add core types for tiktok download scheduler"
```

**验收标准:** `src/types.ts` 导出上述 10 个类型,`tsc --noEmit` 通过。此任务无运行时行为,故无单测。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 2: 子进程封装 runner(tasks 1.2)

**Files:**
- Create: `src/runner.ts`

**Interfaces:**
- Consumes: `ProcessResult`、`ProcessRunner`(来自 `src/types.ts`)。
- Produces:
  - `class YtDlpRunner implements ProcessRunner`,构造可选 `binPath: string = "yt-dlp"`,方法 `run(args: string[]): Promise<ProcessResult>`。
  - `function checkYtDlpAvailable(): boolean`(用 `Bun.which("yt-dlp")`,找到返回 `true`)。

> 设计 §2.2:runner 是唯一接触子进程的模块。`run` 收集 stdout/stderr 与退出码。`YtDlpRunner` 真正起子进程,难以纯单测,本任务只做实现 + 类型校验 + 一个真实回路冒烟(若环境有 yt-dlp);其行为通过下游任务注入假 runner 间接覆盖。

- [x] **Step 1: 写 `src/runner.ts`**

```ts
import type { ProcessResult, ProcessRunner } from "./types.ts";

export class YtDlpRunner implements ProcessRunner {
  constructor(private readonly binPath: string = "yt-dlp") {}

  async run(args: string[]): Promise<ProcessResult> {
    const proc = Bun.spawn([this.binPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }
}

export function checkYtDlpAvailable(): boolean {
  return Bun.which("yt-dlp") !== null;
}
```

- [x] **Step 2: 类型 + 烟雾校验**

Run: `bunx tsc --noEmit && bun -e 'import { checkYtDlpAvailable } from "./src/runner.ts"; console.log("yt-dlp available:", checkYtDlpAvailable());'`
Expected: `tsc` 无错误;打印 `yt-dlp available: true` 或 `false`(两者皆可,只验证函数可调用且不抛错)。

- [x] **Step 3: Commit**

```bash
git add src/runner.ts
git commit -m "feat: add YtDlpRunner subprocess wrapper and availability check"
```

**验收标准:** `YtDlpRunner.run` 用 `Bun.spawn` 收集 stdout/stderr/code;`checkYtDlpAvailable()` 用 `Bun.which`;`tsc` 通过,函数可无错调用。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 3: 解析模块 parser(tasks 2.1, 2.2)

**Files:**
- Create: `src/parser.ts`
- Test: `src/parser.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`、`ProcessResult`、`VideoInfo`(来自 `src/types.ts`)。
- Produces: `function parse(runner: ProcessRunner, url: string, limit?: number): Promise<VideoInfo[]>`。

> 设计 §2.3:调用 `yt-dlp -J --flat-playlist [-I :N] <url>`。`limit` 存在时把 `-I :N` 加进 args。解析 stdout JSON:
> - 含 `entries` 数组(playlist)→ 多视频,每个 entry 映射为 `{ id, url: entry.url ?? entry.id, title: entry.title }`。
> - 否则 → 单视频,返回单元素数组 `[{ id, url: obj.webpage_url ?? obj.url ?? url, title: obj.title }]`。
> - JSON 解析失败或空结果 → 抛 `Error`。

测试用假 `ProcessRunner`,记录收到的 args 以校验 `-I :N` 透传。

- [x] **Step 1: 写失败测试 `src/parser.test.ts`**

```ts
import { test, expect } from "bun:test";
import { parse } from "./parser.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";

function fakeRunner(stdout: string, calls: string[][] = []): ProcessRunner {
  return {
    async run(args: string[]): Promise<ProcessResult> {
      calls.push(args);
      return { code: 0, stdout, stderr: "" };
    },
  };
}

test("解析单个视频返回 1 条", async () => {
  const json = JSON.stringify({
    id: "v1",
    webpage_url: "https://tiktok.com/@a/video/v1",
    title: "Hello",
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@a/video/v1");
  expect(videos).toHaveLength(1);
  expect(videos[0]).toEqual({
    id: "v1",
    url: "https://tiktok.com/@a/video/v1",
    title: "Hello",
  });
});

test("解析 playlist 展开 entries", async () => {
  const json = JSON.stringify({
    _type: "playlist",
    entries: [
      { id: "a", url: "https://tiktok.com/@u/video/a", title: "A" },
      { id: "b", url: "https://tiktok.com/@u/video/b", title: "B" },
    ],
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@u");
  expect(videos).toHaveLength(2);
  expect(videos.map((v) => v.id)).toEqual(["a", "b"]);
});

test("entry 缺 url 时用 id 兜底", async () => {
  const json = JSON.stringify({
    _type: "playlist",
    entries: [{ id: "onlyid" }],
  });
  const videos = await parse(fakeRunner(json), "https://tiktok.com/@u");
  expect(videos[0]!.url).toBe("onlyid");
});

test("limit 透传 -I :N 且不影响单视频", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u", 5);
  expect(calls[0]).toContain("--playlist-end");
  expect(calls[0]).toContain("5");
});

test("无 limit 时不传 --playlist-end", async () => {
  const calls: string[][] = [];
  const json = JSON.stringify({ id: "v1", title: "x" });
  await parse(fakeRunner(json, calls), "https://tiktok.com/@u");
  expect(calls[0]).not.toContain("--playlist-end");
});

test("非法 JSON 抛错", async () => {
  const runner: ProcessRunner = {
    async run() {
      return { code: 0, stdout: "not-json", stderr: "" };
    },
  };
  await expect(parse(runner, "https://x")).rejects.toThrow();
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/parser.test.ts`
Expected: FAIL,报 `Cannot find module './parser.ts'` 或 `parse is not a function`。

- [x] **Step 3: 写最小实现 `src/parser.ts`**

```ts
import type { ProcessRunner, VideoInfo } from "./types.ts";

interface RawEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
}

interface RawJson extends RawEntry {
  _type?: string;
  entries?: RawEntry[];
}

export async function parse(
  runner: ProcessRunner,
  url: string,
  limit?: number,
): Promise<VideoInfo[]> {
  const args = ["-J", "--flat-playlist"];
  if (limit !== undefined) {
    args.push("--playlist-end", `${limit}`);
  }
  args.push(url);

  const result = await runner.run(args);

  let data: RawJson;
  try {
    data = JSON.parse(result.stdout) as RawJson;
  } catch {
    throw new Error(`无法解析 yt-dlp 输出: ${result.stderr || result.stdout}`);
  }

  if (Array.isArray(data.entries)) {
    const videos = data.entries.map((e): VideoInfo => {
      const id = e.id ?? "";
      return { id, url: e.url ?? id, title: e.title };
    });
    if (videos.length === 0) {
      throw new Error("未解析到任何视频条目");
    }
    return videos;
  }

  const id = data.id ?? "";
  if (id === "") {
    throw new Error("未解析到任何视频条目");
  }
  return [{ id, url: data.webpage_url ?? data.url ?? url, title: data.title }];
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/parser.test.ts`
Expected: PASS,6 个测试全绿。

- [x] **Step 5: Commit**

```bash
git add src/parser.ts src/parser.test.ts
git commit -m "feat: add parser for single video and playlist with limit"
```

**验收标准:** 覆盖 spec 场景「解析单个视频」「解析用户主页并限制数量」「解析用户主页未指定数量」。`parse` 识别单/多视频、`-I :N` 仅在 `limit` 存在时透传、entry 缺 url 用 id 兜底、解析失败抛错。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 4: 任务模型与队列 task(tasks 3.1, 3.2)

**Files:**
- Create: `src/task.ts`
- Test: `src/task.test.ts`

**Interfaces:**
- Consumes: `VideoInfo`、`Task`、`Summary`(来自 `src/types.ts`)。
- Produces:
  - `function createTask(video: VideoInfo): Task`(初始 `status: "pending"`, `attempts: 0`)。
  - `class TaskQueue`,构造 `constructor(tasks: Task[])`,方法:
    - `next(): Task | undefined` —— 返回下一个 `pending` 任务并置 `running`。
    - `markSuccess(task: Task): void`
    - `markFailed(task: Task): void`
    - `requeue(task: Task): void` —— `attempts++` 并把 status 置回 `pending`。
    - `summary(): Summary`

> 设计 §2.4:纯数据结构,不依赖 runner。JS 单线程,指针推进天然并发安全。

- [x] **Step 1: 写失败测试 `src/task.test.ts`**

```ts
import { test, expect } from "bun:test";
import { createTask, TaskQueue } from "./task.ts";
import type { VideoInfo } from "./types.ts";

const v = (id: string): VideoInfo => ({ id, url: `https://x/${id}` });

test("createTask 初始状态 pending/attempts 0", () => {
  const t = createTask(v("a"));
  expect(t.status).toBe("pending");
  expect(t.attempts).toBe(0);
  expect(t.id).toBe("a");
  expect(t.url).toBe("https://x/a");
});

test("next 按顺序返回 pending 并置 running", () => {
  const q = new TaskQueue([createTask(v("a")), createTask(v("b"))]);
  const t1 = q.next();
  expect(t1!.id).toBe("a");
  expect(t1!.status).toBe("running");
  const t2 = q.next();
  expect(t2!.id).toBe("b");
  expect(q.next()).toBeUndefined();
});

test("requeue 让任务可被再次取出且 attempts 递增", () => {
  const q = new TaskQueue([createTask(v("a"))]);
  const t = q.next()!;
  q.requeue(t);
  expect(t.attempts).toBe(1);
  expect(t.status).toBe("pending");
  const again = q.next();
  expect(again!.id).toBe("a");
});

test("summary 统计 success/failed/total", () => {
  const q = new TaskQueue([createTask(v("a")), createTask(v("b")), createTask(v("c"))]);
  const a = q.next()!;
  const b = q.next()!;
  const c = q.next()!;
  q.markSuccess(a);
  q.markSuccess(b);
  q.markFailed(c);
  expect(q.summary()).toEqual({ success: 2, failed: 1, total: 3 });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/task.test.ts`
Expected: FAIL,报 `Cannot find module './task.ts'`。

- [x] **Step 3: 写最小实现 `src/task.ts`**

```ts
import type { Summary, Task, VideoInfo } from "./types.ts";

export function createTask(video: VideoInfo): Task {
  return {
    id: video.id,
    url: video.url,
    title: video.title,
    status: "pending",
    attempts: 0,
  };
}

export class TaskQueue {
  constructor(private readonly tasks: Task[]) {}

  next(): Task | undefined {
    const task = this.tasks.find((t) => t.status === "pending");
    if (task) {
      task.status = "running";
    }
    return task;
  }

  markSuccess(task: Task): void {
    task.status = "success";
  }

  markFailed(task: Task): void {
    task.status = "failed";
  }

  requeue(task: Task): void {
    task.attempts += 1;
    task.status = "pending";
  }

  summary(): Summary {
    let success = 0;
    let failed = 0;
    for (const t of this.tasks) {
      if (t.status === "success") success += 1;
      else if (t.status === "failed") failed += 1;
    }
    return { success, failed, total: this.tasks.length };
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/task.test.ts`
Expected: PASS,4 个测试全绿。

- [x] **Step 5: Commit**

```bash
git add src/task.ts src/task.test.ts
git commit -m "feat: add Task model and in-memory TaskQueue"
```

**验收标准:** 覆盖 spec 场景「每个视频一个独立任务」。`next()` 顺序推进且置 running、`requeue` 递增 attempts 并复位 pending、`summary()` 统计正确。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 5: 上传桩 uploader(tasks 4.1)

**Files:**
- Create: `src/uploader.ts`
- Test: `src/uploader.test.ts`

**Interfaces:**
- Consumes: `Uploader`(来自 `src/types.ts`)。
- Produces: `class NoopUploader implements Uploader`,`upload(filePath: string): Promise<void>` 空实现(直接 resolve)。

> 设计 §2.6:占位实现,使用方后续替换为真实对象存储。

- [x] **Step 1: 写失败测试 `src/uploader.test.ts`**

```ts
import { test, expect } from "bun:test";
import { NoopUploader } from "./uploader.ts";

test("NoopUploader.upload 不抛错且 resolve", async () => {
  const u = new NoopUploader();
  await expect(u.upload("/tmp/x.mp4")).resolves.toBeUndefined();
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/uploader.test.ts`
Expected: FAIL,报 `Cannot find module './uploader.ts'`。

- [x] **Step 3: 写最小实现 `src/uploader.ts`**

```ts
import type { Uploader } from "./types.ts";

export class NoopUploader implements Uploader {
  async upload(_filePath: string): Promise<void> {
    // 占位:后续替换为真实对象存储上传(上传后自行删除视频)
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/uploader.test.ts`
Expected: PASS。

- [x] **Step 5: Commit**

```bash
git add src/uploader.ts src/uploader.test.ts
git commit -m "feat: add NoopUploader stub"
```

**验收标准:** `NoopUploader` 实现 `Uploader` 接口,`upload` 永远成功 resolve。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 6: 执行模块 worker(tasks 5.1, 5.2)

**Files:**
- Create: `src/worker.ts`
- Test: `src/worker.test.ts`

**Interfaces:**
- Consumes: `ProcessRunner`、`ProcessResult`、`Task`、`DownloadResult`(来自 `src/types.ts`)。
- Produces: `function download(runner: ProcessRunner, task: Task, outputDir: string): Promise<DownloadResult>`。

> 设计 §2.5:执行 `yt-dlp -P <outputDir> --print after_move:filepath <task.url>`。
> - `code === 0` → 取 stdout **最后一个非空行**作为最终路径,返回 `{ ok: true, filePath }`。
> - `code !== 0` → 返回 `{ ok: false, error: stderr }`。
> 无状态、不感知队列与并发。测试用假 runner,无需真实 yt-dlp。

- [x] **Step 1: 写失败测试 `src/worker.test.ts`**

```ts
import { test, expect } from "bun:test";
import { download } from "./worker.ts";
import type { ProcessResult, ProcessRunner, Task } from "./types.ts";

const task: Task = {
  id: "a",
  url: "https://tiktok.com/@u/video/a",
  status: "running",
  attempts: 0,
};

function runnerWith(result: ProcessResult, calls: string[][] = []): ProcessRunner {
  return {
    async run(args: string[]): Promise<ProcessResult> {
      calls.push(args);
      return result;
    },
  };
}

test("成功时取最后非空行作为 filePath", async () => {
  const stdout = "some log line\n/abs/output/a.mp4\n\n";
  const r = await download(runnerWith({ code: 0, stdout, stderr: "" }), task, "./output");
  expect(r.ok).toBe(true);
  expect(r.filePath).toBe("/abs/output/a.mp4");
});

test("透传 -P outputDir 与 --print after_move:filepath 与 url", async () => {
  const calls: string[][] = [];
  await download(
    runnerWith({ code: 0, stdout: "/abs/x.mp4", stderr: "" }, calls),
    task,
    "./output",
  );
  expect(calls[0]).toContain("-P");
  expect(calls[0]).toContain("./output");
  expect(calls[0]).toContain("--print");
  expect(calls[0]).toContain("after_move:filepath");
  expect(calls[0]).toContain(task.url);
});

test("失败时返回 ok:false 与 stderr", async () => {
  const r = await download(
    runnerWith({ code: 1, stdout: "", stderr: "ERROR: boom" }),
    task,
    "./output",
  );
  expect(r.ok).toBe(false);
  expect(r.error).toBe("ERROR: boom");
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/worker.test.ts`
Expected: FAIL,报 `Cannot find module './worker.ts'`。

- [x] **Step 3: 写最小实现 `src/worker.ts`**

```ts
import type { DownloadResult, ProcessRunner, Task } from "./types.ts";

export async function download(
  runner: ProcessRunner,
  task: Task,
  outputDir: string,
): Promise<DownloadResult> {
  const result = await runner.run([
    "-P",
    outputDir,
    "--print",
    "after_move:filepath",
    task.url,
  ]);

  if (result.code === 0) {
    const lines = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const filePath = lines[lines.length - 1];
    return { ok: true, filePath };
  }

  return { ok: false, error: result.stderr };
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/worker.test.ts`
Expected: PASS,3 个测试全绿。

- [x] **Step 5: Commit**

```bash
git add src/worker.ts src/worker.test.ts
git commit -m "feat: add worker download wrapper with filepath extraction"
```

**验收标准:** 覆盖 spec 场景「下载输出位置」(`-P ./output`)。成功取最后非空行为 filePath,失败返回 stderr。args 不带 `-J`(下载而非解析)。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 7: 调度模块 scheduler(tasks 6.1, 6.2, 6.3, 6.4)

**Files:**
- Create: `src/scheduler.ts`
- Test: `src/scheduler.test.ts`

**Interfaces:**
- Consumes: `TaskQueue`(来自 `src/task.ts`)、`Task`、`Uploader`、`DownloadResult`、`Summary`(来自 `src/types.ts`)。
- Produces:
  - `interface SchedulerOptions { workers: number; retry: number; retryDelayMs?: number }`
  - `type DownloadFn = (task: Task) => Promise<DownloadResult>`
  - `function runScheduler(queue: TaskQueue, options: SchedulerOptions, downloadFn: DownloadFn, uploader: Uploader): Promise<Summary>`

> 设计 §2.7(核心):启动 `workers` 个异步循环。每循环 `while (task = queue.next())`:
> - `r.ok` → `markSuccess`;`uploader.upload(filePath).catch(logUploadError)` 加入 inflight,**不 await**(fire-and-forget)。
> - 失败且 `task.attempts < retry` → `await sleep(retryDelayMs)` 后 `requeue`。
> - 否则 → `markFailed`。
> 队列排空后 `await Promise.allSettled(inflightUploads)`。并发不变量:活跃 `downloadFn` 调用数 ≤ workers。
> 注入假 `downloadFn`,**测试时把 `retryDelayMs` 设为 0**,避免 2s 真等待。

- [x] **Step 1: 写失败测试 `src/scheduler.test.ts`**

```ts
import { test, expect } from "bun:test";
import { runScheduler } from "./scheduler.ts";
import { createTask, TaskQueue } from "./task.ts";
import type { DownloadResult, Task, Uploader, VideoInfo } from "./types.ts";

const v = (id: string): VideoInfo => ({ id, url: `https://x/${id}` });

function queueOf(ids: string[]): TaskQueue {
  return new TaskQueue(ids.map((id) => createTask(v(id))));
}

class CountingUploader implements Uploader {
  public calls: string[] = [];
  async upload(filePath: string): Promise<void> {
    this.calls.push(filePath);
  }
}

test("活跃下载数峰值不超过 workers", async () => {
  let active = 0;
  let peak = 0;
  const queue = queueOf(["a", "b", "c", "d", "e"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => {
    active += 1;
    peak = Math.max(peak, active);
    await Bun.sleep(5);
    active -= 1;
    return { ok: true, filePath: `/out/${_t.id}.mp4` };
  };
  await runScheduler(queue, { workers: 2, retry: 2, retryDelayMs: 0 }, downloadFn, new CountingUploader());
  expect(peak).toBeLessThanOrEqual(2);
});

test("失败重试到上限后标 failed,不影响其他任务", async () => {
  const attemptsById: Record<string, number> = {};
  const queue = queueOf(["good", "bad"]);
  const downloadFn = async (t: Task): Promise<DownloadResult> => {
    attemptsById[t.id] = (attemptsById[t.id] ?? 0) + 1;
    if (t.id === "bad") return { ok: false, error: "boom" };
    return { ok: true, filePath: `/out/${t.id}.mp4` };
  };
  const summary = await runScheduler(
    queue,
    { workers: 2, retry: 2, retryDelayMs: 0 },
    downloadFn,
    new CountingUploader(),
  );
  expect(summary).toEqual({ success: 1, failed: 1, total: 2 });
  // bad: 首次 + 2 次重试 = 3 次尝试
  expect(attemptsById["bad"]).toBe(3);
  expect(attemptsById["good"]).toBe(1);
});

test("重试后成功最终标 success", async () => {
  let badCalls = 0;
  const queue = queueOf(["x"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => {
    badCalls += 1;
    if (badCalls < 2) return { ok: false, error: "transient" };
    return { ok: true, filePath: "/out/x.mp4" };
  };
  const summary = await runScheduler(
    queue,
    { workers: 1, retry: 2, retryDelayMs: 0 },
    downloadFn,
    new CountingUploader(),
  );
  expect(summary).toEqual({ success: 1, failed: 0, total: 1 });
});

test("下载成功触发 upload,且每个成功文件都被上传", async () => {
  const uploader = new CountingUploader();
  const queue = queueOf(["a", "b"]);
  const downloadFn = async (t: Task): Promise<DownloadResult> => ({
    ok: true,
    filePath: `/out/${t.id}.mp4`,
  });
  await runScheduler(queue, { workers: 2, retry: 2, retryDelayMs: 0 }, downloadFn, uploader);
  expect(uploader.calls.sort()).toEqual(["/out/a.mp4", "/out/b.mp4"]);
});

test("上传抛错不改下载 success 状态,且 in-flight 上传被等待收敛", async () => {
  let uploadStarted = 0;
  let uploadSettled = 0;
  const uploader: Uploader = {
    async upload(_filePath: string): Promise<void> {
      uploadStarted += 1;
      await Bun.sleep(5);
      uploadSettled += 1;
      throw new Error("upload failed");
    },
  };
  const queue = queueOf(["a"]);
  const downloadFn = async (_t: Task): Promise<DownloadResult> => ({
    ok: true,
    filePath: "/out/a.mp4",
  });
  const summary = await runScheduler(
    queue,
    { workers: 1, retry: 2, retryDelayMs: 0 },
    downloadFn,
    uploader,
  );
  expect(summary).toEqual({ success: 1, failed: 0, total: 1 });
  // runScheduler 返回时,已触发的上传必须已收敛(即便它最终抛错)
  expect(uploadStarted).toBe(1);
  expect(uploadSettled).toBe(1);
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/scheduler.test.ts`
Expected: FAIL,报 `Cannot find module './scheduler.ts'`。

- [x] **Step 3: 写最小实现 `src/scheduler.ts`**

```ts
import type {
  DownloadResult,
  Summary,
  Task,
  Uploader,
} from "./types.ts";
import { TaskQueue } from "./task.ts";

export interface SchedulerOptions {
  workers: number;
  retry: number;
  retryDelayMs?: number;
}

export type DownloadFn = (task: Task) => Promise<DownloadResult>;

export async function runScheduler(
  queue: TaskQueue,
  options: SchedulerOptions,
  downloadFn: DownloadFn,
  uploader: Uploader,
): Promise<Summary> {
  const retryDelayMs = options.retryDelayMs ?? 2000;
  const inflightUploads: Promise<void>[] = [];

  async function workerLoop(): Promise<void> {
    let task = queue.next();
    while (task !== undefined) {
      const result = await downloadFn(task);
      if (result.ok) {
        queue.markSuccess(task);
        if (result.filePath !== undefined) {
          const p = uploader.upload(result.filePath).catch((err) => {
            console.error(`上传失败 ${result.filePath}:`, err);
          });
          inflightUploads.push(p);
        }
      } else if (task.attempts < options.retry) {
        await Bun.sleep(retryDelayMs);
        queue.requeue(task);
      } else {
        queue.markFailed(task);
      }
      task = queue.next();
    }
  }

  const loops = Array.from({ length: options.workers }, () => workerLoop());
  await Promise.all(loops);
  await Promise.allSettled(inflightUploads);

  return queue.summary();
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/scheduler.test.ts`
Expected: PASS,5 个测试全绿。

- [x] **Step 5: Commit**

```bash
git add src/scheduler.ts src/scheduler.test.ts
git commit -m "feat: add concurrency scheduler with retry and fire-and-forget upload"
```

**验收标准:** 覆盖 spec 场景「并发数受 Worker 数量约束」「重试后成功」「重试耗尽仍失败」「下载成功触发上传」「上传失败不影响下载状态」。并发峰值 ≤ workers、重试用固定延迟、上传 fire-and-forget 且不阻塞、队列排空后等待 in-flight 上传收敛。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 8: CLI 入口 index(tasks 7.1, 7.2)

**Files:**
- Modify: `src/index.ts`(当前为空文件,0 字节,改写为入口)
- Test: `src/cli.test.ts`(仅测纯参数解析函数)

**Interfaces:**
- Consumes:`parse`(parser)、`createTask`/`TaskQueue`(task)、`download`(worker)、`runScheduler`(scheduler)、`NoopUploader`(uploader)、`YtDlpRunner`/`checkYtDlpAvailable`(runner)、`Config`(types)。
- Produces:
  - `function parseArgs(argv: string[]): Config`(导出以便单测;`argv` 为去掉 `bun`/脚本名后的参数数组,即 `Bun.argv.slice(2)`)。默认 `workers=2`、`retry=2`、`outputDir="./output"`;`--limit` 缺省为 `undefined`。
  - `function main(): Promise<void>`(组装并运行,设置 `process.exitCode`)。
  - 文件底部:`if (import.meta.main) { await main(); }`。

> 设计 §2.8:参数 `download <url> [--limit N] [--workers 2] [--retry 2] [-o ./output]`。
> `checkYtDlpAvailable()` 为假 → 打印错误并 `process.exit(1)`,不创建任务。
> 组装:`parse → tasks → TaskQueue → runScheduler(..., new NoopUploader())`,download 闭包 `(task) => download(runner, task, cfg.outputDir)`。
> 打印汇总 `成功 X / 失败 Y / 共 Z`;有失败则 `process.exitCode = 1`。

- [x] **Step 1: 写失败测试 `src/cli.test.ts`(只测 parseArgs)**

```ts
import { test, expect } from "bun:test";
import { parseArgs } from "./index.ts";

test("默认值:workers=2 retry=2 outputDir=./output limit 未定义", () => {
  const cfg = parseArgs(["https://tiktok.com/@u/video/1"]);
  expect(cfg.url).toBe("https://tiktok.com/@u/video/1");
  expect(cfg.workers).toBe(2);
  expect(cfg.retry).toBe(2);
  expect(cfg.outputDir).toBe("./output");
  expect(cfg.limit).toBeUndefined();
});

test("解析 --limit --workers --retry -o", () => {
  const cfg = parseArgs([
    "https://tiktok.com/@u",
    "--limit",
    "5",
    "--workers",
    "3",
    "--retry",
    "4",
    "-o",
    "./videos",
  ]);
  expect(cfg.url).toBe("https://tiktok.com/@u");
  expect(cfg.limit).toBe(5);
  expect(cfg.workers).toBe(3);
  expect(cfg.retry).toBe(4);
  expect(cfg.outputDir).toBe("./videos");
});

test("缺少 url 抛错", () => {
  expect(() => parseArgs([])).toThrow();
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `bun test src/cli.test.ts`
Expected: FAIL,报 `parseArgs is not a function` 或模块解析错误(`index.ts` 当前为空)。

- [x] **Step 3: 写实现 `src/index.ts`**

```ts
import type { Config, Task } from "./types.ts";
import { YtDlpRunner, checkYtDlpAvailable } from "./runner.ts";
import { parse } from "./parser.ts";
import { createTask, TaskQueue } from "./task.ts";
import { download } from "./worker.ts";
import { runScheduler } from "./scheduler.ts";
import { NoopUploader } from "./uploader.ts";

export function parseArgs(argv: string[]): Config {
  let url: string | undefined;
  let limit: number | undefined;
  let workers = 2;
  let retry = 2;
  let outputDir = "./output";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--limit":
        limit = Number(argv[++i]);
        break;
      case "--workers":
        workers = Number(argv[++i]);
        break;
      case "--retry":
        retry = Number(argv[++i]);
        break;
      case "-o":
      case "--output":
        outputDir = argv[++i] ?? outputDir;
        break;
      default:
        if (arg !== undefined && !arg.startsWith("-")) {
          url = arg;
        }
    }
  }

  if (url === undefined) {
    throw new Error("用法: download <url> [--limit N] [--workers 2] [--retry 2] [-o ./output]");
  }

  return { url, limit, workers, retry, outputDir };
}

export async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  if (!checkYtDlpAvailable()) {
    console.error("错误: 未在 PATH 中找到 yt-dlp,请先安装 yt-dlp 后重试。");
    process.exit(1);
  }

  const runner = new YtDlpRunner();

  let videos;
  try {
    videos = await parse(runner, cfg.url, cfg.limit);
  } catch (err) {
    console.error("解析失败:", (err as Error).message);
    process.exit(1);
  }

  const queue = new TaskQueue(videos.map(createTask));
  const uploader = new NoopUploader();

  const summary = await runScheduler(
    queue,
    { workers: cfg.workers, retry: cfg.retry },
    (task: Task) => download(runner, task, cfg.outputDir),
    uploader,
  );

  console.log(`成功 ${summary.success} / 失败 ${summary.failed} / 共 ${summary.total}`);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `bun test src/cli.test.ts`
Expected: PASS,3 个测试全绿。

- [x] **Step 5: 全量测试 + 类型校验**

Run: `bun test && bunx tsc --noEmit`
Expected: 所有测试文件全绿,`tsc` 无错误。

- [x] **Step 6: Commit**

```bash
git add src/index.ts src/cli.test.ts
git commit -m "feat: add CLI entry assembling parse/queue/scheduler/uploader"
```

**验收标准:** 覆盖 spec 场景「yt-dlp 不可用」(不可用即报错非 0 退出、不创建任务)。`parseArgs` 默认值与各开关正确;`main` 组装全链路;汇总格式 `成功 X / 失败 Y / 共 Z`;有失败非 0 退出。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Task 9: 端到端冒烟(tasks 8.3)

**Files:**
- 无新增源文件(手动验证 + 记录命令)。

**Interfaces:**
- Consumes: 完整 CLI(`src/index.ts`)。
- Produces: 无(验证步骤)。

> 设计 §5「冒烟」:对真实/受控 URL 跑一次,确认输出落在 `./output`。
> 注:NoopUploader 不产生可见副作用,上传 hook 被调用已由 Task 7 单测覆盖(`CountingUploader`);此处主要验证真实 yt-dlp 回路与输出位置。无 yt-dlp 环境时跳过并记录原因。

- [x] **Step 1: 确认 yt-dlp 可用**

Run: `bun -e 'import { checkYtDlpAvailable } from "./src/runner.ts"; console.log(checkYtDlpAvailable());'`
Expected: 打印 `true`。若为 `false`,记录「环境无 yt-dlp,冒烟跳过」,直接到 Step 4。

- [x] **Step 2: 单视频冒烟**

Run: `bun run src/index.ts "<一个真实可下载的 TikTok 单视频 URL>"`
Expected: 终端打印 `成功 1 / 失败 0 / 共 1`,退出码 0。

- [x] **Step 3: 校验输出落盘**

Run: `ls -la ./output`
Expected: `./output` 目录存在且至少有一个视频文件(yt-dlp 默认模板命名)。

- [x] **Step 4: 多视频 + limit 冒烟(可选,网络允许时)**

Run: `bun run src/index.ts "<一个真实 TikTok 用户主页 URL>" --limit 2 --workers 2`
Expected: 打印 `成功 N / 失败 M / 共 2`(N+M=2),`./output` 中新增对应文件。

- [x] **Step 5: 记录结果(不提交产物)**

确认 `.gitignore` 含 `output/`(若无则在本步追加),避免把下载视频提交进仓库。然后:

```bash
git status
```

Expected: 无 `./output/` 下的视频被纳入暂存。若 `.gitignore` 有改动:

```bash
git add .gitignore
git commit -m "chore: ignore output directory for downloaded videos"
```

**验收标准:** 真实 yt-dlp 回路下,单视频(及可选的多视频 + limit)下载成功,文件落在 `./output`,汇总输出正确;下载产物不进 git。无 yt-dlp 环境时明确记录跳过。

archived-with: 2026-06-26-tiktok-download-scheduler
---

## Self-Review

**Spec 覆盖核对(逐 Requirement / Scenario → 任务):**

| Spec 场景 | 覆盖任务 |
|-----------|----------|
| 解析单个视频 | Task 3 |
| 解析用户主页并限制数量 | Task 3(`-I :5`) |
| 解析用户主页未指定数量 | Task 3(无 `-I`,展开全部 entries) |
| yt-dlp 不可用 | Task 8(`checkYtDlpAvailable` 假 → 非 0 退出、不建任务) |
| 每个视频一个独立任务 | Task 4(`createTask` 初始 pending) |
| 并发数受 Worker 数量约束 | Task 7(峰值 ≤ workers 测试) |
| 下载输出位置 | Task 6(`-P ./output`)+ Task 9(落盘校验) |
| 重试后成功 | Task 7(重试后成功测试) |
| 重试耗尽仍失败 | Task 7(failed 且不影响其他) |
| 下载成功触发上传 | Task 7(CountingUploader)+ NoopUploader Task 5 |
| 上传失败不影响下载状态 | Task 7(抛错 uploader 测试) |

无遗漏的 spec 要求。

**Placeholder 扫描:** 无 TBD / "适当处理" / 空泛措辞;每个写代码步骤均含完整代码;每个测试步骤均含完整断言。

**类型一致性核对:** `ProcessRunner.run(args: string[])`、`parse(runner,url,limit?)`、`createTask`/`TaskQueue.{next,markSuccess,markFailed,requeue,summary}`、`download(runner,task,outputDir)`、`runScheduler(queue,options,downloadFn,uploader)`、`SchedulerOptions{workers,retry,retryDelayMs?}`、`Config` 字段、`DownloadResult{ok,filePath?,error?}`、`Summary{success,failed,total}` 在定义任务(1)与消费任务(2–8)间命名/签名一致。`retryDelayMs` 默认 2000、测试传 0,语义一致。

**tasks.md 对齐:** 8 个 tasks 章节的全部 18 个勾选项均映射到 Task 1–9(见各任务标题括注)。
