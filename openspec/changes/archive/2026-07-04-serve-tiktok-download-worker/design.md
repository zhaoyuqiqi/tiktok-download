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
