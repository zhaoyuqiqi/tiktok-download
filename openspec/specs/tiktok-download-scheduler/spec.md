# tiktok-download-scheduler Specification

## Purpose
TBD - created by archiving change tiktok-download-scheduler. Update Purpose after archive.
## Requirements
### Requirement: 任务建模与状态管理
系统 SHALL 为每个待抓取帖子创建一个独立任务,任务具有状态(pending / running / success / failed)与重试计数,并 SHALL 持久化到 SQLite,使任务状态在服务重启后不丢失。任务之间相互独立,单个任务的失败 SHALL NOT 影响其他任务。

#### Scenario: 每个帖子一个独立任务
- **WHEN** 抓取到 N 个待处理帖子
- **THEN** 系统创建 N 个相互独立的任务,初始状态均为 pending

#### Scenario: 任务状态持久化
- **WHEN** 服务重启
- **THEN** 已持久化的任务状态与重试计数仍然存在

### Requirement: Worker 池并发执行
系统 SHALL 通过全局并发上限(默认 2,可配置)控制同时进行的抓取任务数量,任意时刻活跃抓取任务数 SHALL NOT 超过该上限。系统 SHALL 保证同一账号的抓取串行执行。

#### Scenario: 并发数受全局上限约束
- **WHEN** 待抓取任务数量大于全局并发上限
- **THEN** 任意时刻活跃抓取任务不超过上限,其余任务排队等待

#### Scenario: 同账号不并行
- **WHEN** 同一账号有多个待抓取任务
- **THEN** 系统串行处理,不对同一账号并行发起抓取

### Requirement: 失败重试
系统 SHALL 在单个帖子抓取或上传失败时进行重试,最多重试 3 次,间隔按指数退避 1 分钟 / 3 分钟 / 10 分钟。重试次数耗尽后 SHALL 将该任务标记为 failed,并继续执行其余任务。

#### Scenario: 退避重试后成功
- **WHEN** 某帖子首次失败,但在 3 次退避重试内成功
- **THEN** 该任务最终标记为 success

#### Scenario: 重试耗尽仍失败
- **WHEN** 某帖子在 3 次退避重试后仍失败
- **THEN** 该任务标记为 failed,其余任务不受影响

### Requirement: 下载成功后上传 hook
系统 SHALL 在每个帖子视频抓取成功后,将视频流上传到 COS 对象存储。上传 SHALL NOT 阻塞其他任务;系统在退出前 SHALL 等待已触发的上传收敛。系统 SHALL 通过纯函数生成 COS 对象 key。

#### Scenario: 抓取成功触发 COS 上传
- **WHEN** 一个帖子视频抓取成功
- **THEN** 系统将该视频流上传到 COS,不阻塞其他任务

#### Scenario: 上传失败不影响其他任务
- **WHEN** COS 上传抛出异常
- **THEN** 系统记录该上传错误,其他任务继续执行

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

