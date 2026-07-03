## MODIFIED Requirements

### Requirement: 任务建模与状态管理
系统 SHALL 为每个待抓取帖子创建一个独立任务,任务具有状态(pending / running / success / failed)与重试计数,并 SHALL 持久化到 SQLite,使任务状态在服务重启后不丢失。任务之间相互独立,单个任务的失败 SHALL NOT 影响其他任务。

#### Scenario: 每个帖子一个独立任务
- **WHEN** 抓取到 N 个待处理帖子
- **THEN** 系统创建 N 个相互独立的任务,初始状态均为 pending

#### Scenario: 任务状态持久化
- **WHEN** 服务重启
- **THEN** 已持久化的任务状态与重试计数仍然存在

### Requirement: 并发执行
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

### Requirement: 下载成功后上传
系统 SHALL 在每个帖子视频抓取成功后,将视频流上传到 COS 对象存储。上传 SHALL NOT 阻塞其他任务;系统在退出前 SHALL 等待已触发的上传收敛。系统 SHALL 通过纯函数生成 COS 对象 key。

#### Scenario: 抓取成功触发 COS 上传
- **WHEN** 一个帖子视频抓取成功
- **THEN** 系统将该视频流上传到 COS,不阻塞其他任务

#### Scenario: 上传失败不影响其他任务
- **WHEN** COS 上传抛出异常
- **THEN** 系统记录该上传错误,其他任务继续执行

## REMOVED Requirements

### Requirement: 解析视频列表
**Reason**: CLI 的 `download <url>` + `--limit` 单视频/主页解析语义被服务化的“列表+详情两段抓取”(见 `tiktok-fetch-pipeline`)取代。
**Migration**: 改用 `tiktok-fetch-pipeline` 的“列表与详情两段抓取”要求,以 `username` + `lastVideoId` 为入口;数量限制由主动抓取“最近 100 条”规则(见 `tiktok-fetch-service`)承担。

### Requirement: 代理支持
**Reason**: CLI `--proxy` 命令行参数语义随 CLI 入口移除;代理改由服务配置管理。
**Migration**: 代理配置改由服务侧环境变量/配置项提供,并在 yt-dlp 调用时透传;不再通过命令行 `--proxy` 传入。

### Requirement: Worker 池并发执行
**Reason**: `--workers` 命令行参数与固定 worker 池、本地 `./output` 落地语义被服务化并发模型取代。
**Migration**: 使用本 delta 的“并发执行”要求(全局并发上限 + 同账号串行)与 `tiktok-fetch-pipeline` 的“视频流直传 COS”(不落地本地磁盘)。
