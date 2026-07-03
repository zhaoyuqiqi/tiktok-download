# Comet Design Handoff

- Change: serve-tiktok-download-worker
- Phase: design
- Mode: compact
- Context hash: 0094c01fa1179155eca6249f64ae5981adad0cfc5daaa6aba3899b14ea0c4770

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/serve-tiktok-download-worker/proposal.md

- Source: openspec/changes/serve-tiktok-download-worker/proposal.md
- Lines: 1-36
- SHA256: a0e3d1c61add3c7e17da978f9a323cdb596b128c1bb3958adb60c9162ba57fbf

```md
## Why

当前 TikTok 下载器是一个一次性 CLI:`download <url>` 解析后跑完即退出,任务状态只在内存、无持久化、无去重、无发布时间排序,重试是固定 2 秒延迟,上传是 no-op 占位,也没有主动抓取某账号与调度能力。这无法支撑“持续、有序、不重复、可调度”的抓取诉求。需要将其重构为常驻的 Elysia Web 服务,把抓取流水线、去重、调度、并发与频率控制、COS 上传、回传落库沉淀为可运维的服务能力。

## What Changes

- **BREAKING**: 移除 CLI 作为主入口(`parseArgs` / `Bun.argv` 驱动的一次性流程),改为 Elysia Web 服务常驻运行。
- 抓取流水线改为:输入 `username` + `lastVideoId` → `yt-dlp -J --flat-playlist` 拉列表 → 对候选逐条 `yt-dlp -J` 拉详情 → 按发布时间从旧到新处理 → 清洗详情 → `yt-dlp -o -` 输出视频流 → 直传 COS → 成功后回传 instar-server(适配层预留)。
- 平台适配器抽象:调度与公共处理逻辑通过平台无关的 `PlatformAdapter` 接口(listPosts/fetchDetail/cleanse/openMediaStream)与具体平台解耦;TikTok 为基于 yt-dlp 的适配器实现,后续接入其他平台只需新增适配器,调度/持久化/并发/退避/去重无需改动。
- 引入 SQLite 持久化,只存最小调度与去重状态:`accounts`(平台、账号、next_run_at、last_post_at、游标、active)与 `fetched_posts`(平台、帖子 id、状态、重试次数、抓取时间,发布时间可选);不存帖子全量信息(标题、作者、媒体 URL、清洗 payload、COS key)。服务重启后不丢(Docker 部署依赖 volume 挂载持久化目录)。
- 去重:相同帖子抓取成功后不再重复下载/上传。
- 排序:帖子按发布时间从远及近抓取与展示,不使用抓取入库时间。
- 重试:单帖子失败最多重试 3 次,指数退避 1 分钟 / 3 分钟 / 10 分钟。
- 并发与频率控制:全局并发默认 2(可配置),同一账号必须串行;每次 yt-dlp 调用前随机延迟 2–8 秒,不用固定最小间隔,以规避风控。
- 调度:采用 due 时间驱动。每个账号在本地维护 `next_run_at`,调度 tick 只挑选已到期且 active 的账号,不每轮批量扫描全部账号;挑选数量受全局并发剩余额度约束以治理积压。抓取周期与相关参数可由环境变量配置。按账号活跃度动态调整——抓完重算 `next_run_at`:24 小时无新帖降低到约 6 小时一次,高频账号可提高频率但最小间隔 30 分钟。
- 账号名单:账号名单的权威源在外部服务(通过外部 HTTP 接口获取)。本服务定期(环境变量配置,默认 5 分钟)拉取全量账号名单与本地 SQLite 对账(reconcile):新增账号 upsert 并置 `next_run_at=now`(带随机 jitter 打散);已存在账号保留其 `next_run_at`/`last_post_at` 不被覆盖;外部已移除账号标记为 inactive 停止调度并保留去重历史。
- 主动触发:外部 HTTP `POST` 主动触发抓取指定账号作为旁路,复用同一抓取流水线与去重,与定时调度不冲突、不重复。
- 主动抓取:支持主动抓取指定账号,帖子过多时只处理最近 100 条,同样遵守去重。
- COS key 命名规则实现为纯函数:输入帖子详情,输出字符串;默认返回 `当前时间 yyyyMMddHHmmss + 帖子 id`。
- 回传 instar-server 做适配层预留,本次不锁定真实接口协议。

## Capabilities

### New Capabilities
- `tiktok-fetch-pipeline`: 单账号抓取流水线——平台适配器抽象(含媒体流)、列表抓取、详情抓取、发布时间排序、数据清洗为平台无关标准化结构、公共层视频流直传 COS、公共层回传适配层、COS key 命名纯函数,以及重试退避规则。
- `tiktok-fetch-service`: Elysia Web 服务形态——HTTP 接口(主动抓取指定账号)、due 驱动的服务内定时调度、外部账号名单 reconcile(定期拉取全量名单与本地对账)、账号活跃度自适应频率、SQLite 持久化的去重与抓取游标、全局并发与同账号串行、随机延迟频率控制、环境变量配置与积压治理。

### Modified Capabilities
- `tiktok-download-scheduler`: 由“CLI 一次性下载 + 内存任务 + 固定重试 + no-op 上传”的规格,调整为服务化抓取语义。原 CLI 入口、`--limit/--workers/--retry/-o` 命令行参数语义、内存-only 任务模型、固定次数重试、no-op 上传 hook 等要求被服务化后的调度、持久化、退避重试、COS 上传等要求取代。

## Impact

- 代码:`src/index.ts`(移除 CLI 主入口)、`src/scheduling/*`(调度与队列重构为平台无关的 due 驱动)、`src/parsing/parser.ts`(并入 TikTok 适配器,补发布时间与详情抓取)、`src/upload/uploader.ts`(公共层接入 COS)、`src/types.ts`;新增 Elysia 服务入口、PlatformAdapter 抽象与 TikTokAdapter、SQLite 最小状态持久化层、due 驱动调度器、账号名单 reconcile 层、去重存储、频率控制、公共层清洗/COS/回传。
- 依赖:新增 Elysia、`cos-nodejs-sdk-v5`、`bun:sqlite`;yt-dlp 通过既有 `YtDlpRunner` 调用。
- 运行形态:从一次性进程改为常驻服务;部署需挂载 SQLite 持久化目录(volume)。
- 上游:账号名单来自外部 HTTP 接口(权威源);成功抓取后回传 instar-server(接口本次预留,不锁定)。
```

## openspec/changes/serve-tiktok-download-worker/design.md

- Source: openspec/changes/serve-tiktok-download-worker/design.md
- Lines: 1-65
- SHA256: 97e30a4a3bf6e4af7da587c4e371382351e49b76947b82332ea8fc3b0e0c6674

```md
## Context

现有实现是一次性 CLI(见 `src/index.ts`):解析 URL → 内存任务队列 → 固定 worker 并发下载 → no-op 上传 → 打印汇总后退出。无持久化、无去重、无发布时间排序、无调度、无真实上传与回传。本次将其重构为常驻的 Elysia Web 服务,承载“持续、有序、不重复、可调度”的抓取诉求。

约束:
- 抓取入口约定为 `username` + `lastVideoId`,先 `-J --flat-playlist` 拉列表,再逐条 `-J` 拉详情。
- yt-dlp 通过既有 `YtDlpRunner`(`src/ytdlp-manager/runner.ts`)调用;COS 上传参考 `test.ts` 用 `cos-nodejs-sdk-v5` + `-o -` 流式直传。
- 需规避风控:同账号串行、全局并发默认 2、每次 yt-dlp 调用前随机延迟 2–8 秒。
- 状态持久化到 SQLite,Docker 部署依赖 volume 挂载。

## Goals / Non-Goals

**Goals:**
- Elysia 服务形态,提供手动触发与主动抓取指定账号的 HTTP 接口。
- 单账号抓取流水线:列表 → 详情 → 按发布时间从旧到新 → 清洗 → `-o -` 直传 COS → 回传适配层。
- SQLite 只持久化最小调度与去重状态(accounts 调度状态 + fetched_posts 去重),不存帖子全量信息。
- 平台适配器抽象:调度器与平台解耦,TikTok 为一个适配器实现,后续平台可直接接入同一调度器。
- 重试最多 3 次,退避 1m/3m/10m;全局并发默认 2 且可配置,同账号串行。
- due 驱动的服务内定时调度 + 外部触发共用流水线;外部 HTTP 接口获取账号名单并定期 reconcile;按账号活跃度自适应频率(24h 无新帖降到约 6h,高频账号最小间隔 30min)。
- 主动抓取帖子过多时只取最近 100 条,仍去重。
- COS key 命名为纯函数,默认 `yyyyMMddHHmmss + 帖子 id`。

**Non-Goals:**
- 不保留 CLI 作为主入口。
- 不锁定 instar-server 真实接口,仅做回传适配层预留。
- 不引入外部消息队列或分布式多副本协同去重。
- 不做完整部署平台建设,仅约束需挂载持久化目录。

## Decisions

- **Elysia 常驻服务 + due 驱动内部调度器**:一个进程内同时跑 HTTP 接口与定时调度,共用同一抓取流水线,避免逻辑分叉。调度采用 due 时间驱动而非全量扫描:每个账号在 `accounts` 表持有 `next_run_at`,调度 tick(约每分钟)只 `SELECT ... WHERE next_run_at <= now AND active` 并 `LIMIT` 为全局并发剩余额度,天然实现“按活跃度挑选”与积压治理。备选一(纯外部 cron 调 HTTP)被否,因为自适应频率需要服务侧跨次记忆每个账号状态;备选二(每周期拉全量账号挨个抓)被否,违反“不每轮批量抓全部”且易造成风控与积压灾难。
- **外部账号名单 reconcile**:账号名单权威源在外部服务,通过外部 HTTP 接口获取。本服务用独立的 reconcile 循环(环境变量配置,默认 5 分钟)拉取全量用户名并与本地 SQLite 对账,该循环只处理名单、不触发 yt-dlp,开销轻。对账规则:新增账号 INSERT 并置 `next_run_at = now + 随机 jitter`(打散避免同批到期);已存在账号只 upsert 基础信息、保留其 `next_run_at`/`last_post_at` 不被覆盖(名单变化不重置调度状态);外部已移除账号标记 `active = false` 停止调度,保留去重历史以便恢复。备选(每 tick 都全量对账)被否,开销高且与调度耦合。
- **外部主动触发为旁路**:HTTP `POST /fetch` 主动抓取指定账号复用同一抓取流水线与去重存储,抓完同样重算 `next_run_at`。定时调度与主动触发只是入队来源不同,不冲突、不重复。
- **自适应频率 = 抓完重算 next_run_at**:每次抓取结束根据是否有新帖重算下次到期时间——有新帖则缩短间隔(下限 30 分钟),连续 24 小时无新帖则拉长到约 6 小时。规则内聚为一次“写回下次时间”,无需独立状态机。
- **SQLite(bun:sqlite)作为单一状态源,只存最小调度与去重状态**:SQLite 只保存“调度决策 + 去重判断”必需的字段,SHALL NOT 存储帖子全量信息。帖子详情/清洗结果只在内存流转,抓完直传 COS + 回传后即丢弃。表结构:
  - `accounts`:`platform`、`account_id`、`next_run_at`、`last_post_at`、`last_video_id`(游标)、`active`,唯一键 `(platform, account_id)`。
  - `fetched_posts`(去重):`platform`、`post_id`、`published_at`(排序/游标,可选)、`status`(success/failed)、`attempts`、`fetched_at`,唯一键 `(platform, post_id)`。
  - 明确不存:title、作者、媒体 URL、清洗后 payload、COS key 等(用完即弃或已落在 COS/instar)。SQLite 只回答两个问题:该账号该不该抓、抓取起点在哪;某帖子抓过没有。
  备选(依赖 instar-server 判重)被否,因回传接口本次不锁定,且需重启不丢与本地自洽。账号名单是外部权威源的缓存,SQLite 只承载调度状态与去重历史。
- **平台适配器,调度器与平台解耦**:调度核心只依赖一个平台无关的 `PlatformAdapter` 抽象接口,不认识任何具体平台。TikTok 是其中一个实现(基于 yt-dlp),未来新增平台只写新适配器注册进来,调度/持久化/并发/退避/去重全部无需改动。
  - `PlatformAdapter` 职责:`listPosts(account, cursor)`、`fetchDetail(post)`、`cleanse(detail)` → 平台无关的标准化 `Post`、`openMediaStream(post)` → 视频流(连视频流也由适配器打开,调度器不碰 yt-dlp)。
  - 公共层职责:COS 上传、instar 回传、SQLite 去重与调度,全部基于平台无关的标准化 `Post` 结构,多平台共用,不重复实现。
  - 平台差异(yt-dlp 参数、字段名、发布时间解析、风控细节)全部在适配器内消化。
- **同账号串行 + 全局并发信号量**:账号级串行避免同账号并行触发风控,全局并发上限控制总压力;两层叠加。
- **随机延迟 2–8 秒**替代固定最小间隔,降低可预测性以规避风控。
- **发布时间排序**:详情抓取阶段提取发布时间戳,处理与展示均以发布时间为序,而非入库时间。
- **COS key 纯函数**:输入帖子详情、输出字符串,便于测试与后续替换命名规则;默认 `yyyyMMddHHmmss + id`。
- **回传适配层接口化**:定义回传抽象(类似现有 `Uploader` 的 hook 思路),默认预留实现,真实 instar-server 接口后续接入。
- **指数退避重试**:1m/3m/10m 三档、最多 3 次,退避期间任务不占用并发额度。

## Risks / Trade-offs

- [SQLite 在容器可写层易丢] → 部署强制挂载 volume/宿主目录,文档与配置显式约束持久化路径。
- [随机延迟 + 同账号串行降低吞吐] → 通过全局并发与账号自适应频率平衡;积压时靠调度挑选而非批量全扫。
- [回传接口未锁定可能返工] → 用适配层隔离,回传数据结构在 design 阶段细化,契约变更只影响适配层。
- [发布时间字段依赖 yt-dlp 详情输出] → 详情抓取阶段校验时间字段,缺失时定义降级排序策略(design 阶段细化)。
- [自适应频率状态机复杂] → 先落最小可用规则(24h/6h、最小 30min),后续按数据调参。

## Open Questions

- 清洗后字段集合与回传 payload 的具体结构(instar-server 接口预留,design 阶段细化)。
- 账号自适应频率的完整重算公式与默认环境变量取值(周期、reconcile 间隔、并发、jitter 范围)。
- 外部账号名单 HTTP 接口的路径/鉴权/返回结构(名单来源接口,design 阶段细化)。
- COS bucket/region/鉴权配置来源(环境变量约定)。
- 发布时间缺失或时区不一致时的排序降级策略。
```

## openspec/changes/serve-tiktok-download-worker/tasks.md

- Source: openspec/changes/serve-tiktok-download-worker/tasks.md
- Lines: 1-43
- SHA256: 302a10e934779f3179bf0d3fb28d86d1cb157c76c550b2c113ca1c8a81335314

```md
## 1. 服务骨架与依赖

- [ ] 1.1 引入 Elysia、cos-nodejs-sdk-v5 依赖,搭建常驻服务入口(替换 CLI 主入口)
- [ ] 1.2 定义服务配置(抓取周期、全局并发、代理、COS、持久化目录)与环境变量约定

## 2. 持久化层(SQLite,最小状态)

- [ ] 2.1 设计并建立 SQLite schema:accounts(platform/account_id/next_run_at/last_post_at/last_video_id/active)、fetched_posts(platform/post_id/published_at?/status/attempts/fetched_at);只存调度与去重必需字段,不存帖子全量信息
- [ ] 2.2 实现去重查询/写入与账号游标读写,保证重启后状态保留

## 3. 平台适配器抽象

- [ ] 3.1 定义平台无关的 PlatformAdapter 接口(listPosts/fetchDetail/cleanse→标准化 Post/openMediaStream)与标准化 Post 结构
- [ ] 3.2 实现 TikTokAdapter(基于 yt-dlp):列表 `-J --flat-playlist`、详情 `-J`、清洗、`-o -` 媒体流

## 4. 抓取流水线(公共层)

- [ ] 4.1 编排入口 username + lastVideoId → 适配器列表+详情,过滤 lastVideoId 之前的已抓帖子
- [ ] 4.2 按发布时间从旧到新排序(平台无关标准化结构)
- [ ] 4.3 实现 COS key 纯函数(输入标准化 Post,默认 yyyyMMddHHmmss + 帖子 id)并编写单测
- [ ] 4.4 实现公共层将适配器媒体流直传 COS(不落地磁盘)
- [ ] 4.5 实现公共层回传 instar-server 的适配层接口与预留实现

## 5. 调度、并发与频率控制(平台无关)

- [ ] 5.1 实现全局并发上限(默认 2,可配置)与同账号串行
- [ ] 5.2 实现指数退避重试(最多 3 次,1m/3m/10m),退避期间不占并发额度
- [ ] 5.3 实现每次适配器抓取调用前 2–8 秒随机延迟(风控由适配器/公共层协作)
- [ ] 5.4 实现 due 驱动调度 tick(只挑 next_run_at 到期且 active,LIMIT 为并发剩余额度)+ 外部 HTTP 主动触发旁路共用同一流水线
- [ ] 5.5 实现外部账号名单 reconcile(外部 HTTP 拉全量,默认 5min 可配;新增置 next_run_at=now+jitter、已存在不覆盖、移除标记 inactive,不触发抓取)
- [ ] 5.6 实现账号活跃度自适应频率(抓完重算 next_run_at:24h 无新帖降到约 6h,高频最小间隔 30min)
- [ ] 5.7 实现主动抓取指定账号,帖子过多时仅取最近 100 条且遵守去重

## 6. HTTP 接口

- [ ] 6.1 提供主动抓取指定账号的 HTTP 接口(旁路触发)
- [ ] 6.2 提供任务/抓取与调度状态查询接口(观测积压、进度与账号 next_run_at)
- [ ] 6.3 实现外部账号名单 HTTP 客户端(权威源拉取)与其配置/鉴权

## 7. 收尾

- [ ] 7.1 补充测试覆盖去重、排序、退避、并发上限、100 条上限、适配器解耦等关键场景
- [ ] 7.2 更新 README/部署说明,明确 Docker 需挂载 SQLite 持久化目录
```

## openspec/changes/serve-tiktok-download-worker/specs/tiktok-download-scheduler/spec.md

- Source: openspec/changes/serve-tiktok-download-worker/specs/tiktok-download-scheduler/spec.md
- Lines: 1-59
- SHA256: c2f9da6c4448fa6f6b224e4e49a4e1090af0e1d14385adbee5c58950f694de9d

```md
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
```

## openspec/changes/serve-tiktok-download-worker/specs/tiktok-fetch-pipeline/spec.md

- Source: openspec/changes/serve-tiktok-download-worker/specs/tiktok-fetch-pipeline/spec.md
- Lines: 1-78
- SHA256: 4dbd5a8d9f8c013ebeafccd6282e201adb0022d9d25a91bcf941dd460ec951fe

```md
## ADDED Requirements

### Requirement: 平台适配器抽象
系统 SHALL 通过平台无关的适配器接口(`PlatformAdapter`)进行抓取,使调度与公共处理逻辑与具体平台解耦。适配器 SHALL 负责:列出账号帖子(`listPosts`)、抓取帖子详情(`fetchDetail`)、清洗详情为平台无关的标准化帖子结构(`cleanse`)、打开帖子媒体流(`openMediaStream`)。调度、并发控制、退避重试、去重、COS 上传与回传等公共逻辑 SHALL NOT 依赖任何具体平台细节,仅依赖该接口与标准化结构。TikTok 适配器 SHALL 基于 yt-dlp 实现。新增其他平台 SHALL 只需实现一个新适配器,不改动调度与公共逻辑。

#### Scenario: 调度器不依赖具体平台
- **WHEN** 调度器发起一次抓取
- **THEN** 调度器只通过 `PlatformAdapter` 接口与标准化帖子结构交互,不直接调用平台特有命令(如 yt-dlp)

#### Scenario: 新增平台只加适配器
- **WHEN** 需要接入一个新平台
- **THEN** 只需实现一个新的 `PlatformAdapter` 并注册,调度、持久化、并发、退避、去重逻辑无需修改

### Requirement: 列表与详情两段抓取
系统 SHALL 以 `username` 与 `lastVideoId` 作为抓取入口:适配器先抓取该账号的帖子列表(TikTok 适配器通过 `yt-dlp -J --flat-playlist`),再对候选帖子逐条抓取详情(TikTok 适配器通过 `yt-dlp -J`)。系统 SHALL 仅抓取 `lastVideoId` 之后的新帖子;当 `lastVideoId` 为空时按抓取策略处理全部候选。

#### Scenario: 先列表后详情
- **WHEN** 传入 `username` 与 `lastVideoId`
- **THEN** 适配器先得到帖子列表,再对每个候选帖子抓取详情

#### Scenario: 仅抓取新帖子
- **WHEN** 列表中包含 `lastVideoId` 及其之前已抓过的帖子
- **THEN** 系统只处理 `lastVideoId` 之后的新帖子,不重复处理已抓过的帖子

### Requirement: 按发布时间从远及近抓取
系统 SHALL 从详情中提取帖子发布时间,并按发布时间从旧到新的顺序处理与展示帖子,SHALL NOT 使用抓取入库时间作为排序依据。

#### Scenario: 发布时间升序处理
- **WHEN** 一批新帖子发布时间各不相同
- **THEN** 系统按发布时间从旧到新依次抓取处理,展示顺序与发布时间一致

#### Scenario: 发布时间缺失时估算并标记
- **WHEN** 某帖子详情中没有可用的发布时间字段
- **THEN** 系统仍抓取该帖子,按列表倒序位置估算其发布时间并标记为估算(不精确),不因缺时间丢弃该帖

### Requirement: 数据清洗
适配器 SHALL 在抓取到帖子详情后将其清洗为平台无关的标准化帖子结构,供公共层的上传与回传使用。标准化结构 SHALL 是平台无关的,公共处理逻辑 SHALL NOT 依赖平台特有字段。

#### Scenario: 清洗详情
- **WHEN** 适配器抓取到一条帖子的原始详情
- **THEN** 适配器清洗出平台无关的标准化帖子结构,供后续公共层 COS 上传与回传使用

### Requirement: 视频流直传 COS
系统 SHALL 由适配器打开帖子媒体流(TikTok 适配器通过 `yt-dlp -o -`),再由公共层将该流直接上传到 COS 对象存储,SHALL NOT 依赖先落地到本地磁盘再上传。COS 对象的 key SHALL 由一个纯函数生成:输入为标准化帖子结构,输出为字符串;默认实现返回 `当前时间 yyyyMMddHHmmss` 拼接当前帖子 id。COS 上传逻辑 SHALL 位于公共层,与具体平台适配器解耦。

#### Scenario: 流式上传
- **WHEN** 一条帖子进入下载阶段
- **THEN** 适配器打开视频流,公共层将其直传 COS,不落地本地磁盘

#### Scenario: 单帖抓取上传超时中止
- **WHEN** 一条帖子从打开媒体流到 COS 上传完成超过配置的单帖超时
- **THEN** 系统强制中止下载子进程与 COS 上传,判该帖失败并进入退避重试,不使任务永久卡住

#### Scenario: 默认 COS key 命名
- **WHEN** 使用默认 COS key 纯函数,输入某标准化帖子结构(id 为 `X`)
- **THEN** 函数返回形如 `yyyyMMddHHmmssX` 的字符串

### Requirement: 失败重试与指数退避
系统 SHALL 在单帖子抓取或上传失败时进行重试,最多重试 3 次,重试间隔按指数退避为 1 分钟、3 分钟、10 分钟。超过 3 次仍失败的帖子 SHALL 标记为最终失败,SHALL NOT 影响其他帖子的处理。退避等待期间该任务 SHALL NOT 占用并发额度。

#### Scenario: 退避后成功
- **WHEN** 某帖子首次失败,在退避重试(1m/3m/10m 之一)后成功
- **THEN** 该帖子最终标记为成功

#### Scenario: 重试耗尽仍失败
- **WHEN** 某帖子在 3 次重试后仍失败
- **THEN** 该帖子标记为最终失败,其余帖子不受影响

### Requirement: 成功后回传适配层
系统 SHALL 在帖子抓取并上传成功后,由公共层通过回传适配层输出平台无关的标准化数据用于 instar-server 落库。回传适配层 SHALL 以抽象接口定义,默认提供预留实现;真实 instar-server 接口本次不锁定。回传逻辑 SHALL 与具体平台适配器解耦。回传失败 SHALL NOT 改变帖子已成功抓取的状态。

#### Scenario: 成功触发回传
- **WHEN** 一条帖子抓取并上传成功
- **THEN** 系统调用回传适配层输出该帖子的标准化数据

#### Scenario: 回传失败不回滚成功状态
- **WHEN** 回传适配层调用失败
- **THEN** 系统记录错误,但该帖子仍视为已成功抓取,不重复抓取
```

## openspec/changes/serve-tiktok-download-worker/specs/tiktok-fetch-service/spec.md

- Source: openspec/changes/serve-tiktok-download-worker/specs/tiktok-fetch-service/spec.md
- Lines: 1-124
- SHA256: 80b5834fb2711afc7a33c223f433cd21a60d4eecf3a77e42836a72b633ae4595

[TRUNCATED]

```md
## ADDED Requirements

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

```

Full source: openspec/changes/serve-tiktok-download-worker/specs/tiktok-fetch-service/spec.md

