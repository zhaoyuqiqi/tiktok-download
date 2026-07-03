# tiktok-download-scheduler Specification

## Purpose
TBD - created by archiving change tiktok-download-scheduler. Update Purpose after archive.
## Requirements
### Requirement: 解析视频列表
系统 SHALL 使用 `yt-dlp -J` 解析输入 URL,并自动识别单视频与用户主页两种来源,产出一个或多个待下载视频条目。当来源为用户主页(包含多个条目)且指定了 `--limit N` 时,系统 SHALL 只取最新的 N 个条目;`--limit` 对单视频来源 SHALL 不生效。系统所使用的 yt-dlp 二进制 SHALL 由 `YtDlpService` 提供的 `current` 托管二进制获取,而非依赖 PATH 中的全局 yt-dlp。

#### Scenario: 解析单个视频
- **WHEN** 用户执行 `download <single-video-url>`
- **THEN** 系统通过 `yt-dlp -J` 解析得到 1 个视频条目,并据此创建 1 个下载任务

#### Scenario: 解析用户主页并限制数量
- **WHEN** 用户执行 `download <user-url> --limit 5`
- **THEN** 系统解析出该用户最新的 5 个视频条目,并创建 5 个下载任务

#### Scenario: 解析用户主页未指定数量
- **WHEN** 用户执行 `download <user-url>` 且未指定 `--limit`
- **THEN** 系统解析出该用户主页下的全部视频条目,并为每个条目创建一个下载任务

#### Scenario: yt-dlp 二进制不可用
- **WHEN** `YtDlpService` 无法解析出可用的 `current` 托管二进制(例如工具目录缺失 `current`)
- **THEN** 系统 SHALL 输出明确的错误信息并以非 0 状态码退出,不创建任何任务

### Requirement: 代理支持
系统 SHALL 支持通过 `--proxy <url>` 指定一个代理地址。当指定该参数时,系统 SHALL 在解析(`yt-dlp -J`)与下载(yt-dlp)两个阶段都将该代理透传给 yt-dlp 的 `--proxy` 选项。未指定时 SHALL 不向 yt-dlp 传 `--proxy`。

#### Scenario: 指定代理透传到解析与下载
- **WHEN** 用户执行 `download <url> --proxy http://127.0.0.1:7890`
- **THEN** 系统在调用 yt-dlp 解析与下载时均带上 `--proxy http://127.0.0.1:7890`

#### Scenario: 未指定代理
- **WHEN** 用户执行 `download <url>` 且未指定 `--proxy`
- **THEN** 系统调用 yt-dlp 时不带 `--proxy` 选项

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

### Requirement: 流式下载输出
系统 SHALL 支持以 `yt-dlp -o - <url>` 形式将下载内容以可读流的方式输出,调用方 SHALL 能将其作为可读流消费(例如管道到 HTTP 响应或文件),而非缓冲为字符串。系统 SHALL 暴露该进程的标准输出可读流、标准错误可读流与退出码。当指定了代理时,流式下载 SHALL 同样将该代理透传给 yt-dlp 的 `--proxy` 选项。

#### Scenario: 以流的方式输出下载内容
- **WHEN** 调用方以流式方式请求下载某个视频(`yt-dlp -o - <url>`)
- **THEN** 系统返回一个可读流,yt-dlp 的媒体字节从标准输出直接流出供调用方消费,且退出码可在进程结束后获取

#### Scenario: 流式下载透传代理
- **WHEN** 调用方以流式方式请求下载并指定了 `--proxy http://127.0.0.1:7890`
- **THEN** 系统在启动 yt-dlp 流式下载进程时带上 `--proxy http://127.0.0.1:7890`

#### Scenario: 流式进程失败时暴露退出码
- **WHEN** 流式下载的 yt-dlp 进程以非 0 状态码退出(如下载中途失败)
- **THEN** 系统暴露的退出码反映该非 0 值,供调用方判断输出可能被截断并据此处理(如删除/重传已上传的对象);系统本身不对截断做兜底

