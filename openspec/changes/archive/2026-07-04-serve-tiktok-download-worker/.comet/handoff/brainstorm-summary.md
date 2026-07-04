# Brainstorm Summary

- Change: serve-tiktok-download-worker
- Date: 2026-07-03

## 确认的技术方案

### 执行引擎(已确认)
- 并发单元 = 账号。一个抓取任务 = 抓一个账号的一批新帖子。
- 全局信号量控制同时运行的账号数 ≤ 2(可配)。同账号串行天然成立(一个账号同一时刻只有一个任务)。
- 账号任务内部按发布时间从旧到新顺序处理帖子。
- 退避:某帖子失败进入 1m/3m/10m 退避时,不在账号任务里干等;把失败帖子落 fetched_posts(status=failed + attempts + next_attempt_at),账号任务结束释放并发额度;调度器在 next_attempt_at 到期时重新拉起该账号补抓该帖子。→ "退避期间不占并发额度" 成立,无需帖子级独立任务表。

### 游标与去重(已确认)
- last_video_id 只当"列表扫描止扫点/优化",推进到本轮见过的最新帖子。
- fetched_posts(唯一键 platform+post_id, status=success)是唯一去重权威。
- 失败帖子靠 fetched_posts 的 failed + next_attempt_at 记录独立驱动重试,用 post_id 直抓,不靠游标回退。
- last_post_at 记录本轮见过的最新发布时间,仅用于自适应频率判断,不参与去重。
- 三者不打架:不重复(success 去重)、失败必重试(failed 记录驱动)、有序(每条独立处理,published_at 落 instar 决定展示序)。

### SQLite 并发写 + 账号占用(已确认)
- 单 SQLite 连接 + PRAGMA journal_mode=WAL + busy_timeout;bun:sqlite 同步 API,单语句原子;写操作短,冲突低;DB 访问全封装在 store 模块。
- 账号占用防重领:挑选账号在一个事务里 SELECT ... WHERE next_run_at<=now AND active AND lease到期 LIMIT k 并立即 UPDATE lease_until=now+基线。主动触发 POST /fetch 走同样占用逻辑,天然与定时调度互斥。
- 租约:lease_until 带超时租约,基线 5min;账号任务活着时每 2min 心跳续租一次(与单帖耗时无关,防大视频下载途中租约过期被重领)。崩溃后最多 5min 租约到期被重领。
- 租约与退避不冲突:退避期间账号已结束任务、释放租约(不干等),两者不在同一时间轴。

### 配置(全部环境变量可配,已确认默认值)
- GLOBAL_CONCURRENCY=2, SCHEDULE_TICK_INTERVAL=60s, RECONCILE_INTERVAL=5min
- LEASE_BASELINE=5min, LEASE_HEARTBEAT=2min
- FETCH_DELAY_MIN=2s / FETCH_DELAY_MAX=8s
- RETRY_BACKOFF=1m,3m,10m, RETRY_MAX=3
- ACTIVE_MIN_INTERVAL=30min, IDLE_INTERVAL=6h, IDLE_THRESHOLD=24h
- ACTIVE_MAX_POSTS=100
- ACCOUNT_LIST_URL(必填), COS_*(必填), SQLITE_PATH(必填/有默认), INSTAR_CALLBACK_*(预留可空)

### 媒体流上传错误与超时(已确认)
- COS 上传:putObject 流式直传(同 test.ts),TikTok 视频几 MB~几十 MB 足够;单帖失败整体重抓,不做断点续传。
- 单帖整体超时 POST_TIMEOUT=5min(可配):从 openMediaStream 到 COS 完成;超时强制 kill yt-dlp 子进程 + abort COS,判失败走退避。也为心跳续租设上界。
- 生命周期绑定:yt-dlp 子进程与 COS 上传任一端失败,另一端立即中止(kill child / destroy stream)。
- 成功判据:yt-dlp 退出码 0 且 COS putObject resolve 才算成功,才写 fetched_posts success 并触发回传;任一不满足即失败走退避链。

### 发布时间缺失降级(已确认)
- 提取(适配器 cleanse):优先 timestamp(秒)→ upload_date(当天0点)→ 都无则列表倒序估算位置。
- 仍抓取,不因缺时间丢数据;published_at 传估算值并标记"不精确";最终展示序由 instar 用 published_at 排。
- TikTok 列表按发布倒序返回,反转即近似发布序。

## 关键取舍与风险

- [失败帖子游标已越过] → 靠 fetched_posts failed 记录 + post_id 直抓,不依赖列表重新带出。
- [大视频下载 > 租约基线] → 2min 心跳续租,与单帖耗时解耦;POST_TIMEOUT 兜底。
- [发布时间缺失] → 仍抓 + 列表序估算并标记,不丢数据。
- 待深入:reconcile 与调度协调、主动抓取旁路与定时调度的去重协调、回传 payload 结构、测试策略。

### 主动触发/定时调度/reconcile 协调(已确认)
- 统一经账号占用:主动触发不直接开抓,走与 due 调度相同的"事务领账号(抢 lease)"入口,天然互斥不重复。
- 主动触发差异:置账号 next_run_at=now(插队) + 标记"本次主动/上限100",复用同一执行引擎,由 tick 领取。
- POST /fetch 异步入队 + 返回 202 受理;进度由状态查询接口看。
- 主动账号本地不存在:允许即时插入一条 active 账号再抓;若后续不在外部名单会被 reconcile 标 inactive。
- 主动触发与定时调度共用全局并发额度(默认2),不单独留额度;并发满时 next_run_at=now 的账号在下个有空额 tick 优先领(到期最早)。
- reconcile 只 upsert 名单和 active,不碰被 lease 账号的 next_run_at/last_post_at;WAL 短事务不阻塞。

## 测试策略(已确认:build 用 TDD)

可注入接缝:ProcessRunner(假 runner)、PlatformAdapter(FakeAdapter)、Uploader(假 COS)、CallbackSink(假回传)、AccountListSource(假名单源)、Clock(可控时钟,手动推进,关键)、SQLite(:memory:/临时文件真实建库)。
分层:
- 纯函数单测:COS key、发布时间提取与降级、退避档位、next_run_at 自适应重算。
- store 单测(真实内存 SQLite):去重 upsert、lease 领取事务(并发领同一账号只一个成功)、游标推进、reconcile upsert/inactive。
- 调度引擎集成(fake adapter + 可控 clock):并发上限、同账号串行、退避释放额度后重拉、100 条上限、主动触发旁路互斥。
- HTTP 接口(Elysia)集成:POST /fetch 返回 202 入队、状态查询、非名单账号即时插入。
- 流水线集成:列表→详情→排序→上传→回传→去重全链、失败走退避、上传失败不回滚已成功、超时中止。
架构强约束:所有外部边界构造函数注入,强化适配器解耦与可测性。

## Spec Patch

候选(待确认,拟回写):
- tiktok-fetch-pipeline:补"发布时间缺失降级"验收场景(仍抓+列表序估算并标记);补"单帖超时中止"验收场景。
- tiktok-fetch-service:补"账号占用/lease 防重领"验收场景;补"主动触发异步 202 + 非名单账号即时插入"验收场景。
- 均为补充验收场景/边界,不改结构与范围。
