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
