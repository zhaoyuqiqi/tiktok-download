## Context

Bun + TypeScript 的全新项目(`src/index.ts` 仅 Hello World)。目标是用外部 `yt-dlp` 实现 TikTok 视频的批量下载调度。约束:

- 运行时为 Bun(优先 Bun 内置 API,不引入第三方 npm 依赖)
- 外部依赖 `yt-dlp` 已在 PATH(`/opt/homebrew/bin/yt-dlp`)
- 无持久化需求(内存队列),CLI 一次性运行
- 模块需职责清晰、低耦合

## Goals / Non-Goals

**Goals:**
- 解析 / 任务 / 执行 / 并发四阶段职责分离,模块间通过明确接口协作
- 通过固定 Worker 数控制并发,活跃 yt-dlp 进程数 ≤ workers
- 单视频失败重试且故障隔离(不影响其他任务)
- 预留 `Uploader` 接口,下载成功后异步触发,不阻塞、不影响下载状态

**Non-Goals:**
- 持久化、断点续传、跳过已下载
- HTTP 服务 / 库 API
- 取消 / 暂停 / 进度条 UI
- 对象存储上传的具体实现(仅接口 + no-op 桩)

## Decisions

### 1. 模块划分(低耦合)
```
cli  ──▶ parser ──▶ task(Queue) ──▶ scheduler ──▶ worker ──▶ yt-dlp
                                          │                     │
                                          └── uploader ◀────────┘(下载成功后)
```
- `parser`:输入 URL + limit,输出 `VideoInfo[]`。封装 `yt-dlp -J` 调用与 entries 展开。
- `task`:定义 `Task`(id/url/title/status/attempts)与内存 `TaskQueue`(FIFO 取任务、状态更新、汇总统计)。纯数据结构,不依赖 yt-dlp。
- `worker`:对单个 Task 启动一个 yt-dlp 子进程下载,返回成功/失败。无状态,不感知队列。
- `scheduler`:持有 N 个 Worker 循环,从 TaskQueue 取任务派发、处理重试、成功后触发 uploader。并发控制的唯一所在。
- `uploader`:`interface Uploader { upload(filePath: string): Promise<void> }` + `NoopUploader` 桩。
- `cli`:参数解析、组装上述模块、打印汇总。

**Rationale**:解析与执行解耦,使任务来源(单视频/用户)对执行层透明;scheduler 是唯一掌握并发的组件,worker 只管下载一个视频,职责单一。

### 2. 并发模型:固定 Worker 协程 + 共享队列
启动 N 个异步 worker 循环,各自 `while (task = queue.next()) { download }`。N 由 `--workers` 控制。
**Alternative**:用 Promise 信号量包裹一次性 `Promise.all` — 放弃,因为 worker 循环模型更直观地对应"Worker 数量 = 并发数",且天然实现取一个下一个。

### 3. yt-dlp 调用:Bun.spawn 子进程
解析用 `yt-dlp -J <url>`(+ `-I :N` 限制数量,flat 模式加速列表解析);下载用 `yt-dlp -o '<output>/%(...)s' <video-url>`。
**Alternative**:让一个 yt-dlp 下载整个 playlist — 放弃,因为无法做 per-video 故障隔离与并发控制(用户明确要求)。

### 4. 失败重试在 scheduler 层
worker 返回失败 → scheduler 判断 `attempts < retry` 则重入队列/重试,否则标 `failed`。重试逻辑集中在调度层,worker 保持无状态。

### 5. 上传 hook:异步 fire-and-forget
下载成功后 scheduler 调用 `uploader.upload(filePath).catch(logError)`,不 await 进主流程关键路径,保证上传失败不影响下载任务状态与其他任务。

## Risks / Trade-offs

- [yt-dlp 不在 PATH 或版本差异] → 启动时检测 yt-dlp 可用性,缺失则明确报错退出
- [并发过高触发 TikTok 限流] → 默认 workers=2 保守值,可 CLI 调整
- [fire-and-forget 上传在进程退出时可能未完成] → scheduler 在全部任务结束后等待 in-flight 上传 Promise 收敛再退出(汇集 upload promise)
- [yt-dlp 输出文件路径获取] → 下载成功后用 `--print after_move:filepath` 或解析 yt-dlp 输出获取实际文件路径传给 uploader;具体方式在 design 阶段细化
