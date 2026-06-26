---
comet_change: tiktok-download-scheduler
role: technical-design
canonical_spec: openspec
archived-with: 2026-06-26-tiktok-download-scheduler
status: final
---

# TikTok 下载任务调度管理 — 技术设计

> 需求与验收场景以 OpenSpec delta spec 为准:
> `openspec/changes/tiktok-download-scheduler/specs/tiktok-download-scheduler/spec.md`。
> 本文档只描述「如何实现」。

## 1. 概览

CLI 工具,用外部 `yt-dlp` 下载 TikTok 视频。支持单个视频与某用户最新 N 个视频。
四阶段:解析 → 任务建模 → Worker 池并发执行 → 失败重试,下载成功后异步触发上传 hook(接口桩)。

- 运行时:Bun + TypeScript,不引入第三方 npm 依赖
- 外部依赖:`yt-dlp`(2026.06.09,需在 PATH)
- 无持久化(内存队列),一次性 CLI 运行

```
index.ts/cli ─▶ parser ─▶ task(Queue) ─▶ scheduler ─▶ worker ─▶ runner ─▶ yt-dlp
                                             │                    ▲
                                             └─▶ uploader         └ ProcessRunner(唯一接触子进程处)
```

## 2. 模块设计

低耦合原则:每个模块单一职责、通过显式接口协作、可独立测试。`runner` 是唯一接触子进程的模块,其余模块通过依赖注入接收它或其产物,从而无需真实 yt-dlp 即可单测。

### 2.1 types.ts
集中定义核心类型:

```ts
export type TaskStatus = "pending" | "running" | "success" | "failed";

export interface VideoInfo {
  id: string;
  url: string;          // 用于下载的页面 URL(entry.url ?? 由 id 兜底)
  title?: string;       // flat-playlist 下可能缺失
}

export interface Task {
  id: string;
  url: string;
  title?: string;
  status: TaskStatus;
  attempts: number;     // 已尝试次数
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
  limit?: number;       // 仅多视频生效
  workers: number;      // 默认 2
  retry: number;        // 默认 2
  outputDir: string;    // 默认 ./output
}
```

### 2.2 runner.ts — 子进程封装
- `ProcessRunner` 接口 + `YtDlpRunner`(`Bun.spawn` 实现),`run(args)` 启动 `yt-dlp <args>`,收集 stdout/stderr 与退出码,返回 `ProcessResult`。
- **唯一接触子进程的地方**。parser、worker 都依赖 `ProcessRunner`,测试时注入假实现。
- 提供 `checkYtDlpAvailable()`:用 `Bun.which("yt-dlp")` 判断可用性。

### 2.3 parser.ts — 解析阶段
- `parse(runner, url, limit?): Promise<VideoInfo[]>`
- 调用 `yt-dlp -J --flat-playlist [-I :N] <url>`(`limit` 存在时传 `-I :N`)。
- 解析 stdout JSON:
  - 若对象含 `entries` 数组(`_type === "playlist"`)→ 多视频,映射每个 entry 为 `VideoInfo{ id, url: entry.url ?? entry.id, title: entry.title }`。
  - 否则 → 单视频,返回单元素数组。`-I :N` 对单视频不产生多余条目(自然不生效)。
- 解析失败或空结果 → 抛出明确错误,由 CLI 捕获并非 0 退出。

### 2.4 task.ts — 任务建模
- `createTask(video): Task`(初始 `status:"pending"`, `attempts:0`)。
- `TaskQueue`:
  - 构造接收 `Task[]`。
  - `next(): Task | undefined` —— 返回下一个 `pending` 任务并置 `running`(JS 单线程,指针推进天然并发安全)。
  - `markSuccess(task)` / `markFailed(task)` / `requeue(task)`(重试:`attempts++` 并回到可取状态)。
  - `summary(): { success, failed, total }`。
- 纯数据结构,不依赖 yt-dlp / runner。

### 2.5 worker.ts — 执行阶段
- `download(runner, task, outputDir): Promise<{ ok: boolean; filePath?: string; error?: string }>`
- 执行 `yt-dlp -P <outputDir> --print after_move:filepath <task.url>`。
- `code === 0` → 从 stdout 取**最后一个非空行**作为最终文件路径,返回 `{ ok:true, filePath }`。
- `code !== 0` → 返回 `{ ok:false, error: stderr }`。
- 无状态、不感知队列与并发,只负责"下一个视频"。

### 2.6 uploader.ts — 上传桩
- `interface Uploader`(见 types)。
- `NoopUploader implements Uploader { async upload(_filePath) {} }`——占位,使用方后续替换为真实对象存储实现(上传后自行删除视频)。

### 2.7 scheduler.ts — 并发控制(核心)
- `run(queue, { workers, retry, retryDelayMs=2000 }, download, uploader): Promise<Summary>`
- 启动 `workers` 个异步循环;每个循环:
  ```
  while (task = queue.next()) {
    const r = await download(task);
    if (r.ok) {
      queue.markSuccess(task);
      const p = uploader.upload(r.filePath).catch(logUploadError);
      inflightUploads.add(p);            // fire-and-forget,不 await
    } else if (task.attempts < retry) {
      await sleep(retryDelayMs);
      queue.requeue(task);               // 固定延迟后重试
    } else {
      queue.markFailed(task);
    }
  }
  ```
- **并发不变量**:活跃 `download` 调用数 ≤ `workers`(由循环数量保证),即活跃 yt-dlp 进程 ≤ workers。
- 所有 worker 循环结束(队列空)后 `await Promise.allSettled(inflightUploads)`,确保进程退出前上传收敛。
- 重试与上传编排集中于此,worker/uploader 保持无状态/无并发感知。

### 2.8 cli.ts / index.ts — 入口
- 解析参数:`download <url> [--limit N] [--workers 2] [--retry 2]`(简单手写 argv 解析,无第三方库)。
- `checkYtDlpAvailable()` 失败 → 打印错误并 `process.exit(1)`。
- 组装:`parse → tasks → TaskQueue → scheduler.run(..., NoopUploader)`。
- 结束打印汇总:`成功 X / 失败 Y / 共 Z`;有失败则非 0 退出。

## 3. 数据流

```
url ──parse──▶ VideoInfo[] ──map──▶ Task[] ──▶ TaskQueue
                                                  │  next()
                              workers×[ download(task) ]
                                       │ ok                 │ fail
                              markSuccess + upload(fp)   attempts<retry? requeue(delay) : markFailed
                                       │
                              (queue drained) await inflight uploads ──▶ summary
```

## 4. 边界条件

- yt-dlp 不在 PATH → 启动即报错退出,不创建任务。
- 单视频 URL → parser 返回 1 条;`--limit` 无副作用。
- 用户主页未指定 `--limit` → 下载全部条目(已补充验收场景)。
- 下载失败 → 固定 2s 延迟重试至 `retry` 次,耗尽标 `failed`,不影响其他任务。
- 任务数 > workers → 排队,活跃进程 ≤ workers。
- 上传抛错 → 仅记日志,下载任务仍 `success`,其他任务继续。
- flat-playlist entry 仅有 id 无 url → `entry.url ?? entry.id` 兜底。

## 5. 测试策略

`bun test` 单元测试(注入假实现,无需真实 yt-dlp):
- **parser**:假 `ProcessRunner` 喂①单视频 JSON ②playlist+entries JSON ③校验 `limit` 透传 `-I :N`。
- **task/queue**:`next()` 顺序、状态流转、`summary()` 统计。
- **scheduler**:注入假 `download`,断言:
  1. 活跃下载数峰值 ≤ workers(并发计数器)。
  2. 失败任务重试到上限后 `failed`,且不影响其他任务完成。
  3. 上传 fire-and-forget 不阻塞下载;上传抛错不改下载 `success` 状态。
  4. 队列排空后等待 in-flight 上传收敛。
- **冒烟**:对真实/受控 URL 跑一次,确认输出落在 `./output` 且上传 hook 被调用。

## 5b. 代理支持(范围扩展)

CLI 新增可选 `--proxy <url>`,写入 `Config.proxy`。`parse(runner,url,limit?,proxy?)` 与 `download(runner,task,outputDir,proxy?)` 在 proxy 存在时向 yt-dlp args 追加 `--proxy <url>`,使解析与下载两个阶段都经代理。未指定时不传 `--proxy`。理由:TikTok 在部分网络环境需经代理访问。

## 6. 非目标

持久化、断点续传、跳过已下载、取消/暂停、进度条 UI、HTTP 服务/库 API、对象存储上传具体实现。
