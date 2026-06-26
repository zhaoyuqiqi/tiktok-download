# Comet Design Handoff

- Change: tiktok-download-scheduler
- Phase: design
- Mode: compact
- Context hash: bdd7a823a47e99c72a4564045f72ab63888e355bdfbad37f1425f200fff5d1f2

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/tiktok-download-scheduler/proposal.md

- Source: openspec/changes/tiktok-download-scheduler/proposal.md
- Lines: 1-28
- SHA256: 2b83e775fe449f3f18bc80d7997e6a834e6a5ff4549cad39ff99927fd5371957

```md
## Why

需要一个可控的方式批量下载 TikTok 视频:既能下单个视频,也能下某用户最新的 N 个视频。直接用一个 yt-dlp 进程下载整批会缺乏并发控制和失败隔离;一次启动大量 yt-dlp 进程又会压垮资源并易被限流。需要一个职责清晰、低耦合的任务调度器,通过固定数量的 Worker 控制总体并发。

## What Changes

- 新增一个 CLI 工具:`download <url> [--limit N] [--workers 2] [--retry 2]`
- **解析阶段**:用 `yt-dlp -J` 解析 URL,自动识别单视频(单条 info)或用户主页(含 `entries[]`);`--limit N` 仅多视频时生效(取最新 N 个)
- **任务阶段**:为每个视频创建一个独立的内存任务(状态:pending / running / success / failed)
- **执行阶段**:每个 Worker 从队列取一个任务,启动一个 yt-dlp 子进程下载该视频,输出到 `./output`(文件名用 yt-dlp 默认模板)
- **并发控制**:通过 Worker 数量(默认 2)控制总体并发,任意时刻活跃 yt-dlp 进程数 ≤ workers
- **失败重试**:单个视频下载失败按 `--retry`(默认 2)重试,耗尽后标记 `failed`,不影响其他任务
- 新增 `Uploader` 接口 + no-op 桩:每个视频下载成功后立即异步调用 `upload(filePath)`,不阻塞下载,上传失败不影响下载任务状态(具体上传与删除逻辑由使用方后续实现)

## Capabilities

### New Capabilities
- `tiktok-download-scheduler`: TikTok 视频下载任务的解析、任务建模、Worker 池并发执行、失败重试,以及下载成功后的上传 hook(接口桩)

### Modified Capabilities
<!-- 无,这是全新能力 -->

## Impact

- 新增源码模块:`parser`(解析)/ `task`(任务模型+内存队列)/ `worker`(执行单个 yt-dlp)/ `scheduler`(并发派发)/ `uploader`(上传接口桩)/ CLI 入口
- 运行时依赖:外部 `yt-dlp` 可执行文件(需在 PATH);Bun 子进程 API 启动 yt-dlp
- 输出目录:在当前工作目录下新增 `./output`
- 无持久化、无网络服务、不引入第三方 npm 依赖(使用 Bun 内置能力)
```

## openspec/changes/tiktok-download-scheduler/design.md

- Source: openspec/changes/tiktok-download-scheduler/design.md
- Lines: 1-60
- SHA256: 08b28bbe603b1e671ebbcdaaa313b72337d9db8f490b13dc8ce47fe4fa19375f

```md
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
```

## openspec/changes/tiktok-download-scheduler/tasks.md

- Source: openspec/changes/tiktok-download-scheduler/tasks.md
- Lines: 1-41
- SHA256: b3b01c95373d4a3665d6d3c40752fcaab14c2bbc42fb219380bf3b16ee734f22

```md
## 1. 项目骨架与类型

- [ ] 1.1 创建 `src/types.ts`(或在各模块内)定义 `VideoInfo`、`Task`、`TaskStatus`、`Uploader`、CLI 配置等核心类型
- [ ] 1.2 启动时检测 `yt-dlp` 可用性的工具函数(缺失则报错退出)

## 2. 解析模块(parser)

- [ ] 2.1 实现 `parser` 用 `yt-dlp -J` 解析 URL,返回 `VideoInfo[]`
- [ ] 2.2 自动识别单视频 vs 用户主页(entries 展开),`--limit N` 仅多视频生效(`-I :N`)

## 3. 任务模块(task)

- [ ] 3.1 实现 `Task` 模型与状态流转(pending/running/success/failed + attempts)
- [ ] 3.2 实现内存 `TaskQueue`(取下一个任务、状态更新、汇总统计)

## 4. 上传模块(uploader)

- [ ] 4.1 定义 `Uploader` 接口 `upload(filePath): Promise<void>` 并实现 `NoopUploader` 桩

## 5. 执行模块(worker)

- [ ] 5.1 实现 `worker`:对单个 Task 用 `Bun.spawn` 启动一个 yt-dlp 进程下载到 `./output`
- [ ] 5.2 下载成功后获取实际文件路径(`--print after_move:filepath`)供上传使用

## 6. 调度模块(scheduler)

- [ ] 6.1 实现固定 N 个 Worker 循环从队列取任务,保证活跃进程数 ≤ workers
- [ ] 6.2 失败重试逻辑(attempts < retry 重试,否则标 failed)
- [ ] 6.3 下载成功后异步 fire-and-forget 调用 `uploader.upload`,收集 in-flight 上传 Promise
- [ ] 6.4 全部任务结束后等待 in-flight 上传收敛再返回

## 7. CLI 入口

- [ ] 7.1 实现 `download <url> [--limit] [--workers 2] [--retry 2] [-o ./output]` 参数解析
- [ ] 7.2 组装 parser → task → scheduler → uploader,运行并打印汇总(成功/失败计数)

## 8. 测试与验证

- [ ] 8.1 task/queue 与 scheduler 并发约束的单元测试(mock worker,验证活跃数 ≤ workers、重试、上传不阻塞)
- [ ] 8.2 parser 解析逻辑测试(mock yt-dlp -J 输出:单视频 / entries / limit)
- [ ] 8.3 端到端冒烟:对真实/受控 URL 跑一次,确认输出落在 ./output 且上传 hook 被调用
```

## openspec/changes/tiktok-download-scheduler/specs/tiktok-download-scheduler/spec.md

- Source: openspec/changes/tiktok-download-scheduler/specs/tiktok-download-scheduler/spec.md
- Lines: 1-60
- SHA256: b96f34daad97f1554009b93e8b00b8c2fdb6eb57fa156323ddf94b5c34de2fc9

```md
## ADDED Requirements

### Requirement: 解析视频列表
系统 SHALL 使用 `yt-dlp -J` 解析输入 URL,并自动识别单视频与用户主页两种来源,产出一个或多个待下载视频条目。当来源为用户主页(包含多个条目)且指定了 `--limit N` 时,系统 SHALL 只取最新的 N 个条目;`--limit` 对单视频来源 SHALL 不生效。

#### Scenario: 解析单个视频
- **WHEN** 用户执行 `download <single-video-url>`
- **THEN** 系统通过 `yt-dlp -J` 解析得到 1 个视频条目,并据此创建 1 个下载任务

#### Scenario: 解析用户主页并限制数量
- **WHEN** 用户执行 `download <user-url> --limit 5`
- **THEN** 系统解析出该用户最新的 5 个视频条目,并创建 5 个下载任务

#### Scenario: 解析用户主页未指定数量
- **WHEN** 用户执行 `download <user-url>` 且未指定 `--limit`
- **THEN** 系统解析出该用户主页下的全部视频条目,并为每个条目创建一个下载任务

#### Scenario: yt-dlp 不可用
- **WHEN** 运行环境中 `yt-dlp` 不在 PATH 中
- **THEN** 系统 SHALL 输出明确的错误信息并以非 0 状态码退出,不创建任何任务

### Requirement: 任务建模与状态管理
系统 SHALL 为每个视频创建一个独立的内存任务,任务具有状态(pending / running / success / failed)与重试计数。任务之间相互独立,单个任务的失败 SHALL NOT 影响其他任务。

#### Scenario: 每个视频一个独立任务
- **WHEN** 解析得到 N 个视频条目
- **THEN** 系统创建 N 个相互独立的任务,初始状态均为 pending

### Requirement: Worker 池并发执行
系统 SHALL 通过固定数量的 Worker(由 `--workers` 控制,默认 2)从任务队列中取任务执行。每个 Worker 对一个视频 SHALL 启动且仅启动一个 yt-dlp 子进程。任意时刻活跃的 yt-dlp 进程数 SHALL NOT 超过 Worker 数量。视频 SHALL 下载到当前目录下的 `./output` 目录,文件名使用 yt-dlp 默认模板。

#### Scenario: 并发数受 Worker 数量约束
- **WHEN** 任务数量大于 Worker 数量(如 5 个任务、`--workers 2`)
- **THEN** 系统任意时刻活跃的 yt-dlp 进程不超过 2 个,剩余任务排队等待空闲 Worker

#### Scenario: 下载输出位置
- **WHEN** 一个视频下载成功
- **THEN** 视频文件位于当前工作目录下的 `./output` 目录中,文件名为 yt-dlp 默认模板

### Requirement: 失败重试
系统 SHALL 在单个视频下载失败(yt-dlp 进程非 0 退出)时按 `--retry`(默认 2)进行重试。重试次数耗尽后 SHALL 将该任务标记为 failed,并继续执行其余任务。

#### Scenario: 重试后成功
- **WHEN** 某视频首次下载失败,但在重试次数内的某次重试中成功
- **THEN** 该任务最终标记为 success

#### Scenario: 重试耗尽仍失败
- **WHEN** 某视频在 `--retry` 次重试后仍然失败
- **THEN** 该任务标记为 failed,其余任务不受影响,继续执行至全部结束

### Requirement: 下载成功后上传 hook
系统 SHALL 在每个视频下载成功后立即调用 `Uploader.upload(filePath)`。该调用 SHALL 为异步且不阻塞后续下载;上传失败 SHALL NOT 改变下载任务的成功状态,也 SHALL NOT 影响其他任务。系统 SHALL 提供默认的 no-op `Uploader` 实现作为占位。系统在全部下载任务结束后 SHALL 等待已触发的上传调用收敛后再退出。

#### Scenario: 下载成功触发上传
- **WHEN** 一个视频下载成功
- **THEN** 系统以该视频文件路径异步调用 `Uploader.upload`,且不阻塞其他视频的下载

#### Scenario: 上传失败不影响下载状态
- **WHEN** `Uploader.upload` 抛出异常
- **THEN** 系统记录该上传错误,但对应下载任务仍为 success,其他任务继续执行
```

