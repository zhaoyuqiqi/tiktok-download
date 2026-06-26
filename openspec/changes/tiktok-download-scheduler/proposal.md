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
