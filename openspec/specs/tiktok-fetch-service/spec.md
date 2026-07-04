# tiktok-fetch-service Specification

## Purpose
TBD - created by archiving change serve-tiktok-download-worker. Update Purpose after archive.
## Requirements
### Requirement: Elysia Web 服务形态
系统 SHALL 以基于 Elysia 的常驻 Web 服务形式运行,而非一次性 CLI 进程。服务 SHALL 提供 HTTP 接口用于主动触发抓取指定账号,并在服务内部运行 due 驱动的定时调度;两条路径 SHALL 共用同一抓取流水线与去重存储。

#### Scenario: 常驻服务运行
- **WHEN** 启动服务
- **THEN** 服务常驻运行并对外提供 HTTP 接口,不在完成一次抓取后退出

#### Scenario: 手动触发抓取
- **WHEN** 外部通过 HTTP 接口请求抓取某账号
- **THEN** 服务复用同一抓取流水线执行该账号的抓取

### Requirement: 主动抓取账号数量上限
系统 SHALL 支持主动抓取指定账号的帖子。当该账号帖子过多时,系统 SHALL 只处理最近 100 条帖子,并 SHALL 遵守去重规则。

#### Scenario: 限制最近 100 条
- **WHEN** 主动抓取某账号且其帖子数量超过 100
- **THEN** 系统只处理最近 100 条帖子

#### Scenario: 主动抓取仍去重
- **WHEN** 主动抓取的账号中包含已成功抓取过的帖子
- **THEN** 系统跳过这些帖子,不重复下载或上传

#### Scenario: 主动触发异步受理
- **WHEN** 外部通过 HTTP 主动触发抓取某账号
- **THEN** 系统将该账号入队(置为尽快抓取)并立即返回受理响应,不阻塞等待抓取完成;抓取进度可通过状态查询接口获取

#### Scenario: 主动触发的账号本地不存在
- **WHEN** 主动触发抓取的账号本地尚未存在于账号名单中
- **THEN** 系统即时插入一条 active 账号记录并抓取,不依赖名单对账时机

### Requirement: SQLite 持久化去重与游标
系统 SHALL 使用本地 SQLite 持久化账号调度状态(`accounts`:平台、账号标识、`next_run_at`、`last_post_at`、抓取游标、`active`)与帖子去重记录(`fetched_posts`:平台、帖子 id、状态、重试次数、抓取时间,发布时间可选)。系统 SHALL NOT 在 SQLite 中存储帖子的全量信息(如标题、作者、媒体 URL、清洗后 payload、COS key),这些数据用完即弃或已落在 COS/instar。相同帖子抓取成功后 SHALL NOT 被重复抓取。服务重启后上述状态 SHALL 仍然保留(在 Docker 部署下依赖持久化目录挂载)。

#### Scenario: 只存调度与去重必需字段
- **WHEN** 一条帖子抓取并上传成功
- **THEN** SQLite 中只新增该帖子的去重记录(平台、id、状态等),不存储帖子标题、作者、媒体 URL 或清洗后的全量 payload

#### Scenario: 成功后不再重复抓取
- **WHEN** 某帖子已被标记为成功抓取
- **THEN** 后续定时或手动触发都不会重复下载或上传该帖子

#### Scenario: 重启后状态保留
- **WHEN** 服务重启且持久化目录仍在
- **THEN** 已抓取去重记录、账号抓取游标与任务状态仍然存在

### Requirement: 并发限制与同账号串行
系统 SHALL 限制全局并发抓取数量,默认上限为 2 且 SHALL 可配置。系统 SHALL 保证同一账号的抓取串行执行,SHALL NOT 对同一账号并行抓取。

#### Scenario: 全局并发受限
- **WHEN** 待抓取任务数超过全局并发上限
- **THEN** 任意时刻活跃抓取任务数不超过配置上限,其余排队等待

#### Scenario: 同账号串行
- **WHEN** 同一账号存在多个待抓取任务
- **THEN** 系统串行处理该账号的任务,不并行发起

#### Scenario: 账号占用防重复领取
- **WHEN** 定时调度与主动触发在同一时刻都试图抓取同一账号
- **THEN** 系统通过账号占用(带超时租约)保证该账号只被一条路径领取执行,另一条跳过,不重复抓取

#### Scenario: 崩溃后租约到期可重新领取
- **WHEN** 某账号在抓取中因进程崩溃未释放占用
- **THEN** 其占用租约到期后该账号可被重新领取,不会永久卡住

### Requirement: yt-dlp 调用随机延迟
系统 SHALL 在每次调用 yt-dlp 前插入 2 到 8 秒的随机延迟以规避风控,SHALL NOT 使用固定的最小调用间隔。

#### Scenario: 调用前随机延迟
- **WHEN** 系统即将发起一次 yt-dlp 调用
- **THEN** 系统先等待一个 2–8 秒之间的随机时长再发起调用

### Requirement: 可配置抓取周期与积压治理
系统 SHALL 支持通过环境变量配置抓取周期,并提供默认值。调度 SHALL 考虑帖子积压问题,在积压时仍受全局并发上限约束稳定消费,SHALL NOT 无限并发。

#### Scenario: 环境变量配置周期
- **WHEN** 通过环境变量设置抓取周期
- **THEN** 系统按该周期调度;未设置时使用默认周期

#### Scenario: 积压下稳定消费
- **WHEN** 待抓取帖子出现积压
- **THEN** 系统在全局并发上限内稳定消费,不无限并发

### Requirement: due 驱动调度
系统 SHALL 以 due 时间驱动进行调度:每个账号在本地持久化一个下次到期时间 `next_run_at`。调度 tick 到达时,系统 SHALL 仅挑选 `next_run_at` 已到期且处于 active 的账号进行抓取,SHALL NOT 每轮批量扫描全部账号。每个 tick 挑选的账号数量 SHALL 受全局并发剩余额度约束。

#### Scenario: 只挑到期账号
- **WHEN** 调度 tick 到达,部分账号 `next_run_at` 已到期、部分未到期
- **THEN** 系统只对已到期且 active 的账号发起抓取,未到期账号不处理

#### Scenario: 挑选数量受并发约束
- **WHEN** 到期账号数量超过全局并发剩余额度
- **THEN** 系统本轮只挑选不超过剩余额度的账号,其余账号等待后续 tick

### Requirement: 账号活跃度自适应频率
系统 SHALL 在每次抓取结束后根据该账号是否有新帖重算其 `next_run_at`,以动态调整抓取频率。对连续 24 小时内无新帖的账号,系统 SHALL 降低抓取频率(约 6 小时抓取一次);对发布频率较高的账号,系统 MAY 提高抓取频率,但最小抓取间隔 SHALL NOT 低于 30 分钟。

#### Scenario: 不活跃账号降频
- **WHEN** 某账号连续 24 小时内没有发布新帖
- **THEN** 系统将该账号的 `next_run_at` 拉长到约 6 小时后

#### Scenario: 高频账号提频但受下限约束
- **WHEN** 某账号发布频率较高
- **THEN** 系统缩短其抓取间隔,但两次抓取间隔不小于 30 分钟

### Requirement: 外部账号名单对账
系统 SHALL 通过外部 HTTP 接口获取待抓账号名单(权威源),并定期(间隔由环境变量配置,默认 5 分钟)与本地 SQLite 对账。对账循环 SHALL 只处理账号名单,SHALL NOT 触发 yt-dlp 抓取。对账时:新增账号 SHALL 被插入并置 `next_run_at` 为当前时间(可加随机 jitter 打散);已存在账号 SHALL 保留其 `next_run_at` 与 `last_post_at` 不被覆盖;外部名单中已移除的账号 SHALL 被标记为 inactive 停止调度,并保留其去重历史。

#### Scenario: 新增账号进入调度
- **WHEN** 对账发现外部名单中存在本地没有的账号
- **THEN** 系统插入该账号并置 `next_run_at` 为当前时间(带 jitter),使其在后续 tick 被挑到

#### Scenario: 已存在账号不重置调度状态
- **WHEN** 对账时某账号已存在于本地
- **THEN** 系统不覆盖其 `next_run_at` 与 `last_post_at`

#### Scenario: 已移除账号停止调度
- **WHEN** 某账号不再出现在外部名单中
- **THEN** 系统将其标记为 inactive 不再调度,但保留其去重历史

#### Scenario: 对账不触发抓取
- **WHEN** 执行一次名单对账
- **THEN** 系统只更新账号名单与状态,不发起任何 yt-dlp 抓取

