# Brainstorm Summary

- Change: decouple-worker-executors
- Date: 2026-07-15

## 确认的技术方案

- 已确认采用调度与执行解耦方案：调度器只负责发现 due account 并唤醒 worker，不直接执行业务抓取。
- 已确认 worker 是抽象类体系；每个 worker 都必须实现 `run()` 方法。
- 已确认注册表以 worker class 作为注册值，而不是以实例或字符串工厂作为主注册对象。
- 已确认支持 `[local, github-action]` 多 worker 并行竞争账号级任务；同一账号通过租约互斥。
- 已确认 GitHub Actions 不接收批量 payload，而是启动后自行 claim 账号任务。
- 已确认账号内帖子逐条处理、逐条提交结果，后续失败不回滚已成功帖子。
- 已确认 worker 抽象类拆两层：`run()` 负责 worker 主循环，`executeAccount()` 负责单账号执行。
- 已确认逐条帖子结果直接写 `fetched_posts`，不单独建 post_execution_results 表；新增 account_leases / worker_instances / account_execution_runs。
- 已确认 github-action worker 是外部异步执行者：从本地服务视角是 fire-and-forget，其成功与否只依赖 Actions 内部通过内部 API 回调（逐条 post result + 账号 complete）。
- 已确认 github-action worker 在 Actions 内做的事与本地现有能力一致，但不使用代理。
- 已确认唤醒方式首版用本地 workflow_dispatch（GitHub REST API）主动触发，后续再支持 cron 定时触发。
- 已确认 Actions worker 执行模型：有任务立即抽干（处理完立刻拉下一个），无任务时续期心跳 + 连续空领 N 次后退出；不设应用层最大运行时长上限，GitHub Actions 作为临时计算节点，抽干即退出。
- 已确认本地触发做 dispatch 去抖：已有活跃 run 时不重复拉起。
- 已确认引入账号级任务表 tasks：字段 id / account / status / retry_count / next_retry_at（+ 租约字段）。
- status 枚举：PENDING / RUNNING / SUCCESS / FAILED；retry_count 默认 0，最大 3。
- 任务级指数退避：next_retry_at = now + 3min / 15min / 30min。
- FAILED 且未达最大重试次数、到达 next_retry_at 后重置为 PENDING 供重新拾取。
- 任务去重创建规则：account 存在 PENDING/RUNNING/未达上限的 FAILED 任务时不新建；仅当 FAILED 且达最大重试次数、或 SUCCESS 时才允许新建任务。
- 租约：RUNNING 且租约过期后重置为 PENDING；租约默认 5 分钟，Actions 每 30 秒续期一次、每次续 3 分钟。
- 任务级重试(3m/15m/30m, 账号粒度) 与帖子级重试(1m/3m/10m, 现有 pipeline) 是两层，互不替代。
- 已确认用 tasks 表合并租约，不再单独建 account_leases / account_execution_runs。
- 已确认 partial 映射为任务 SUCCESS（已成功帖子已落 fetched_posts，失败帖子由帖子级重试兜底），不触发任务级重试。
- 已确认调度器新职责：不再调用 listDueAccounts 后直接抓取；改为 listDueAccounts 后按去重规则创建 PENDING 任务（无该账号任务时也创建），执行交给 worker claim。

## 关键取舍与风险

- 候选：worker 注册表采用纯内存 class 注册 + 运行时 worker 上报能力，或引入持久化 worker discovery。
- 候选：账号租约需要 heartbeat + TTL，避免 worker 崩溃后账号永久卡住。
- 候选：local worker 若也走统一 claim/report 链路，改动更大但最终结构更一致。

## 测试策略

- 候选：覆盖多 worker 竞争 claim、同账号互斥、租约超时回收。
- 候选：覆盖逐条帖子提交、部分成功汇总、GitHub Actions pull-based claim。

## Spec Patch

无
