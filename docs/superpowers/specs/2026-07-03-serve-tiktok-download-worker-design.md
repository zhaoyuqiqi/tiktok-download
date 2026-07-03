---
comet_change: serve-tiktok-download-worker
role: technical-design
canonical_spec: openspec
---

# TikTok 下载服务化技术设计

将一次性 CLI 下载器重构为常驻 Elysia Web 服务:due 驱动调度、SQLite 最小状态持久化、平台适配器解耦、并发/串行/退避控制、COS 流式上传、instar 回传预留。本文是实现层技术设计,需求规格以 OpenSpec delta spec 为准。

## 架构分层

平台无关的公共层承载调度、持久化、并发、退避、去重、COS 上传、回传;平台差异全部下沉到 `PlatformAdapter`。

```
                       Elysia HTTP 服务
        POST /fetch(异步202) · GET 状态查询 · 健康检查
                              │
        ┌─────────────────────┼──────────────────────┐
   定时 tick(60s)        主动触发入队           reconcile 循环(5min)
        └─────────────────────┼──────────────────────┘  外部名单HTTP→upsert/inactive
                              ▼
                    Scheduler(平台无关)
        事务领账号(抢 lease) · 全局并发≤2 · 同账号串行
                              ▼
                    FetchPipeline(公共层)
   list→详情→发布时间排序→openMediaStream→COS putObject→回传→写 fetched_posts
                              │ 只依赖抽象
                    PlatformAdapter 接口
              listPosts/fetchDetail/cleanse/openMediaStream
                              ▼
                    TikTokAdapter(基于既有 YtDlpRunner)
```

### 模块与职责

| 模块 | 职责 | 依赖 |
|---|---|---|
| `PlatformAdapter`(接口) | listPosts/fetchDetail/cleanse/openMediaStream | 无(平台实现) |
| `TikTokAdapter` | yt-dlp 列表/详情/清洗/媒体流 | `ProcessRunner`(YtDlpRunner) |
| `Store`(SQLite) | accounts/fetched_posts 读写、lease 事务、reconcile upsert | `bun:sqlite`、`Clock` |
| `Scheduler` | due 挑选、并发信号量、同账号串行、退避重拉 | `Store`、`Adapter`、`Clock` |
| `FetchPipeline` | 单账号一批帖子端到端处理 | `Adapter`、`Uploader`、`CallbackSink`、`Store`、`Clock` |
| `Uploader`(COS) | putObject 流式上传 | `cos-nodejs-sdk-v5` |
| `CallbackSink`(instar) | 回传标准化数据(预留实现) | 外部 HTTP(预留) |
| `AccountListSource` | 外部 HTTP 拉全量账号名单 | 外部 HTTP |
| `Reconciler` | 名单对账 upsert/inactive | `AccountListSource`、`Store`、`Clock` |
| `HTTP`(Elysia) | POST /fetch、状态查询、健康检查 | `Scheduler`、`Store` |
| `Clock` | 可注入时钟(now/sleep) | 无 |
| `Config` | 环境变量解析与默认值 | 无 |

所有外部边界通过构造函数注入,便于测试与多平台扩展。

## 数据模型(SQLite,仅最小状态)

只保存"调度决策 + 去重判断"必需字段,不存帖子全量信息。

```
accounts
  platform        TEXT       平台标识(tiktok/...)
  account_id      TEXT       平台内账号唯一标识(username)
  next_run_at     INTEGER    下次到期时间(epoch ms),due 驱动核心
  last_post_at    INTEGER    本轮见过的最新发布时间,自适应频率用
  last_video_id   TEXT       列表止扫游标(优化,非去重权威)
  active          INTEGER    1/0,reconcile 维护
  lease_until     INTEGER    账号占用租约到期(epoch ms),NULL/过期=可领
  PRIMARY KEY (platform, account_id)

fetched_posts
  platform        TEXT
  post_id         TEXT
  published_at    INTEGER    发布时间(epoch ms),可为估算值
  published_est   INTEGER    1=估算(缺原始时间),0=精确
  status          TEXT       success / failed
  attempts        INTEGER    已重试次数
  next_attempt_at INTEGER    下次重试时间(failed 时),epoch ms
  fetched_at      INTEGER    成功抓取时间
  PRIMARY KEY (platform, post_id)
```

明确不存:title、作者、媒体 URL、清洗后 payload、COS key。SQLite 只回答:该账号该不该抓、抓取起点在哪;某帖子抓过没有。

WAL + busy_timeout,单连接封装在 `Store`。

## 执行引擎:并发 / 串行 / 退避

### 并发单元 = 账号

一个抓取任务 = 抓一个账号的一批新帖子。全局信号量控制同时运行的账号数 ≤ `GLOBAL_CONCURRENCY`(默认 2)。同账号串行天然成立:一个账号同一时刻只有一个任务(由 lease 保证)。账号任务内部按发布时间从旧到新逐帖处理。

### 领账号(防重复领取)

调度 tick、主动触发都走同一领取入口。在一个事务里:

```
SELECT platform, account_id FROM accounts
WHERE active=1 AND next_run_at<=:now
  AND (lease_until IS NULL OR lease_until<=:now)
ORDER BY next_run_at ASC
LIMIT :remaining;              -- remaining = 全局并发 - 在跑数
-- 对选中账号立即 UPDATE lease_until=:now+LEASE_BASELINE
```

同一账号不会被两条路径同时领走。`ORDER BY next_run_at ASC` 让最早到期(含主动触发 next_run_at=now)优先。

### lease 心跳续租

账号任务活着时每 `LEASE_HEARTBEAT`(默认 2min)`UPDATE lease_until=now+LEASE_BASELINE`(默认 5min)。与单帖耗时解耦,防大视频下载途中租约过期被重领。进程崩溃后 ≤5min 租约到期被重领。任务结束(正常/失败)清 lease。

### 退避不占并发额度

帖子失败(详情/下载/上传/超时任一)时,写 `fetched_posts`(status=failed, attempts+1, next_attempt_at=now+backoff[attempts]),**不在账号任务里干等**;账号任务处理完本轮其余帖子后结束、释放 lease。调度器除挑 due 到期账号外,还挑"存在 failed 且 next_attempt_at 到期"的帖子所属账号重新领取,用 `post_id` 直抓该帖(不依赖列表重新带出)。退避档位 `RETRY_BACKOFF`=1m/3m/10m,`RETRY_MAX`=3,耗尽标记最终 failed。

### 游标与去重协同

- `last_video_id` 只作列表止扫优化,推进到本轮见过的最新帖子。
- `fetched_posts`(platform+post_id, status=success)是唯一去重权威;列表候选先查去重表跳过已成功。
- `last_post_at` 记录本轮最新发布时间,仅供自适应频率判断。

## 抓取流水线(单账号一批)

```
1. 读 accounts 得 last_video_id / last_post_at
2. adapter.listPosts(account, cursor) → 候选列表(倒序返回)
3. 过滤:去掉 last_video_id 之前的;查 fetched_posts 跳过已 success 的;
   主动模式截取最近 ACTIVE_MAX_POSTS(默认100)条
4. 反转为发布时间从旧到新
5. 逐帖:
   a. 随机延迟 FETCH_DELAY_MIN~MAX(默认2-8s)
   b. adapter.fetchDetail(post) → 原始详情
   c. adapter.cleanse(detail) → 标准化 Post(含 published_at + published_est)
   d. openMediaStream(post) + uploader.upload(stream, cosKey(post))
      整体包 POST_TIMEOUT(默认5min);超时 kill 子进程 + abort COS
   e. 成功判据:yt-dlp 退出码0 且 COS resolve
      成功 → callbackSink.send(标准化Post) → 写 fetched_posts success
      失败 → 写 failed + next_attempt_at(退避)
   f. 更新 last_video_id / last_post_at
6. 抓完重算 next_run_at(自适应频率),清 lease
```

### 发布时间提取与降级(adapter.cleanse)

优先 `timestamp`(秒)→ `upload_date`(当天0点)→ 都无则按列表倒序位置估算,置 `published_est=1`。仍抓取不丢数据;`published_at` 传估算值并标记,最终展示序由 instar 用 `published_at` 决定。

### COS key 纯函数

输入标准化 Post,输出字符串;默认 `yyyyMMddHHmmss + post.id`。纯函数便于测试与后续替换规则。

### 媒体流上传生命周期

`putObject` 流式直传(TikTok 视频几 MB~几十 MB)。yt-dlp 子进程与 COS 上传生命周期绑定:任一端失败立即中止另一端(kill child / destroy stream)。单帖失败整体重抓,不做断点续传。

## 自适应频率(抓完重算 next_run_at)

```
有新帖:  next_run_at = now + max(ACTIVE_MIN_INTERVAL, 动态间隔)   -- 下限 30min
连续 IDLE_THRESHOLD(24h) 无新帖: next_run_at = now + IDLE_INTERVAL(6h)
```

规则内聚为一次"写回下次时间",无独立状态机。首次/新增账号 `next_run_at=now+jitter`。

## 账号名单 reconcile

独立循环,间隔 `RECONCILE_INTERVAL`(默认5min)。`AccountListSource` 拉全量用户名 → 与本地对账:

- 新增:INSERT `next_run_at=now+jitter`、active=1。
- 已存在:只 upsert 基础信息,**保留** next_run_at/last_post_at/lease。
- 外部已移除:UPDATE active=0(inactive)停调度,保留去重历史。

只处理名单、不触发 yt-dlp。WAL 下短事务,不阻塞正在 lease 的账号抓取。外部名单接口失败时保留现有名单不清空,下轮重试。

## HTTP 接口(Elysia)

| 方法 | 路径 | 行为 |
|---|---|---|
| POST | /fetch | 主动抓取指定账号:置 next_run_at=now + 主动/上限100 标记;账号不存在则即时插入 active;异步入队,返回 202 受理 |
| GET | /status | 抓取/调度状态:积压、在跑账号、各账号 next_run_at、失败重试队列 |
| GET | /health | 健康检查 |

主动触发与定时调度共用全局并发额度,经同一领账号入口互斥,不重复。

## 错误处理与边界

- yt-dlp 子进程错误/非0退出 → 该帖失败走退避。
- COS 上传失败/超时 → 中止子进程,该帖失败走退避。
- 单帖 POST_TIMEOUT 超时 → 强制中止两端,失败走退避。
- 回传失败 → 记录错误,不回滚 fetched_posts success,不重复抓取。
- 进程崩溃 → lease 到期后账号被重领;fetched_posts success 保证不重复。
- 发布时间缺失 → 估算并标记,仍抓。
- 外部名单接口失败 → 本轮 reconcile 跳过,保留现有名单,下轮重试(不清空账号)。

## 配置(环境变量)

| 变量 | 含义 | 默认 |
|---|---|---|
| `GLOBAL_CONCURRENCY` | 全局并发账号数 | 2 |
| `SCHEDULE_TICK_INTERVAL` | 调度 tick 间隔 | 60s |
| `RECONCILE_INTERVAL` | 名单对账间隔 | 5min |
| `LEASE_BASELINE` | 账号租约基线 | 5min |
| `LEASE_HEARTBEAT` | 租约心跳间隔 | 2min |
| `FETCH_DELAY_MIN`/`MAX` | 抓取前随机延迟 | 2s/8s |
| `POST_TIMEOUT` | 单帖抓取+上传超时 | 5min |
| `RETRY_BACKOFF` | 退避档位 | 1m,3m,10m |
| `RETRY_MAX` | 最大重试次数 | 3 |
| `ACTIVE_MIN_INTERVAL` | 高频账号最小间隔 | 30min |
| `IDLE_INTERVAL` | 不活跃账号间隔 | 6h |
| `IDLE_THRESHOLD` | 不活跃判定时长 | 24h |
| `ACTIVE_MAX_POSTS` | 主动抓取上限 | 100 |
| `ACCOUNT_LIST_URL` | 外部名单接口 | 必填 |
| `COS_*` | bucket/region/密钥 | 必填 |
| `SQLITE_PATH` | 持久化文件路径 | 有默认 |
| `INSTAR_CALLBACK_*` | 回传配置(预留) | 可空 |

## 测试策略(build 用 TDD)

可注入接缝:`ProcessRunner`、`PlatformAdapter`、`Uploader`、`CallbackSink`、`AccountListSource`、`Clock`(可控时钟,手动推进)、SQLite(`:memory:`/临时文件真实建库)。

分层:
- 纯函数单测:COS key、发布时间提取与降级、退避档位、next_run_at 自适应重算。
- store 单测(真实内存 SQLite):去重 upsert、lease 领取事务(并发领同一账号只一个成功)、游标推进、reconcile upsert/inactive。
- 调度引擎集成(fake adapter + 可控 clock):并发上限、同账号串行、退避释放额度后重拉、100 条上限、主动触发旁路互斥。
- HTTP 集成(Elysia):POST /fetch 返回 202 入队、状态查询、非名单账号即时插入。
- 流水线集成:列表→详情→排序→上传→回传→去重全链、失败走退避、上传失败不回滚已成功、超时中止。

不碰真实网络/yt-dlp 进程;时间驱动逻辑全部用可控 Clock 测,避免真 sleep。

## 风险 / 权衡

- [随机延迟+同账号串行降吞吐] → 全局并发+自适应频率平衡,积压靠 due 挑选。
- [SQLite 容器易丢] → 强制挂载 volume。
- [回传接口未锁定] → 适配层隔离,契约变更只影响适配层。
- [时间驱动难验证] → Clock 注入 + 可控推进。
- [外部名单接口抖动] → reconcile 失败保留现有名单不清空。

## 非目标

- 不保留 CLI 主入口;不锁定 instar 真实接口;不引入外部消息队列或分布式多副本协同去重;不做断点续传;不做完整部署平台(仅约束挂载持久化目录)。
