---
comet_change: decouple-worker-executors
role: technical-design
canonical_spec: openspec
---

# 调度与执行解耦 · Worker 执行器体系设计

## 1. 背景与目标

当前 due 调度与手动触发最终都在服务进程内直接调用账号抓取流程（`dueScheduler` → `runAccount` → `runAccountIngest`），执行模型被固定在“当前进程直接跑”，无法演进到多 worker 并发竞争、GitHub Actions 外部执行等形态。

本设计在不重写抓取流水线的前提下，引入一层可注册的 worker 执行器体系，把“谁来执行”从调度器剥离：

- 调度器只负责发现 due 账号并**创建账号级任务**，再唤醒可用 worker。
- worker 通过统一协议**竞争领取 PENDING 任务**、续租、执行、逐条上报结果。
- 首批支持 `local` 与 `github-action` 两类 worker，且协议统一、可扩展。

OpenSpec delta spec 是需求事实源，本文档只描述实现方案。

## 2. 核心架构

```text
本地服务进程
  dueScheduler        ── 发现 due 账号 → 按去重规则创建 PENDING 任务
  workerWakeService   ── 根据注册 worker + dispatch 去抖唤醒 worker
  worker-api (Elysia) ── register / claim / renew / posts-result / complete
  WorkerRegistry      ── 以 class 为注册值
  LocalWorker(run)    ── 进程内 ClaimingWorker，执行体带代理

GitHub Actions runner（外部临时计算节点，异步）
  GithubActionWorker(run) ── 启动后自行 claim，执行体不带代理
                            逐条 posts-result + complete 回调本地服务
```

关键点：`LocalWorker` 运行在本地服务进程内；`GithubActionWorker` 运行在 Actions runner 内。二者是同一抽象体系的两个实现，从本地服务视角，github-action 的结果只通过回调获得（fire-and-forget + callback）。

## 3. Worker 抽象类体系（方案 A）

```text
abstract class AbstractWorker {
  abstract run(): Promise<void>
  protected abstract executeAccount(input: AccountTaskInput): Promise<AccountExecutionSummary>
}

abstract class ClaimingWorker extends AbstractWorker {
  // 通用主循环：register → claim → 心跳续租 → executeAccount → complete → 空领退出
  async run(): Promise<void> { ... }
}

class LocalWorker extends ClaimingWorker {
  protected executeAccount(...) // 复用现有抓取链路，带代理
}

class GithubActionWorker extends ClaimingWorker {
  protected executeAccount(...) // 同一抓取链路，proxy = 无
}
```

- 抽象类必须实现 `run()`；单账号执行逻辑落在 `executeAccount()`。
- 注册以 class 为值：`registerWorker(LocalWorker)` / `registerWorker(GithubActionWorker)`。
- claim loop / heartbeat / 空领退出只在 `ClaimingWorker` 写一遍。

### 3.1 主循环（run）

```text
run():
  register(worker_id, worker_type)
  emptyClaims = 0
  loop:
    task = claim()
    if task:
      emptyClaims = 0
      startHeartbeat(task)          # 后台每 30s renew，延长租约 3min
      try: summary = executeAccount(task)
      finally: stopHeartbeat()
      complete(task, summary)
      continue                       # 立即抽干下一个
    emptyClaims += 1
    if emptyClaims >= MAX_EMPTY_ROUNDS: break   # 空领退出
    sleep(IDLE_WAIT ≈ 30s)
```

- 不设应用层最大运行时长上限；GitHub Actions 作为临时计算节点，抽干即退出（平台 6h 硬上限属兜底）。

### 3.2 单账号执行（executeAccount，逐条提交）

```text
executeAccount(task):
  posts = listNewPosts(task)           # 复用现有 pipeline
  for post in posts:
    r = processOnePost(post)           # 抓取+上传+同步（含帖子级 1m/3m/10m 重试）
    postResult(task, post, r)          # 逐条提交，立即落 fetched_posts
    # 单条失败不 throw 中断账号，记录后继续
  return summarize(posts)              # SUCCESS / FAILED（partial 归为 SUCCESS）
```

## 4. 数据模型

沿用现有 `accounts`、`fetched_posts`；新增 `tasks` 与 `worker_instances`。不单独建 post 级结果表，逐条结果直接写 `fetched_posts`（`(platform, post_id)` 主键天然幂等）。

### 4.1 tasks（账号级任务 + 租约合一）

| 字段 | 说明 |
|------|------|
| `id` | 任务主键 |
| `platform` | 平台 |
| `account` | 账号标识 |
| `status` | `PENDING` / `RUNNING` / `SUCCESS` / `FAILED` |
| `retry_count` | 默认 0，最大 3 |
| `next_retry_at` | 下次可重试时间 |
| `worker_id` | RUNNING 时的持有者 |
| `lease_token` | 租约令牌 |
| `lease_expires_at` | 租约到期时间 |
| `created_at` / `updated_at` | 时间戳 |

`account_leases` 与 `account_execution_runs` 被合并进 `tasks`，不单独建表。

### 4.2 worker_instances（运行态，非注册表）

`worker_id` / `worker_type` / `status` / `last_heartbeat_at` / `started_at` / `metadata`。worker class 注册在进程内 `WorkerRegistry`，不入库。

## 5. 任务状态机与规则

```text
PENDING --claim--> RUNNING
RUNNING --全部处理完成--> SUCCESS
RUNNING --执行失败--> FAILED
  ├─ retry_count < 3: next_retry_at = now + 退避; 到点 FAILED -> PENDING
  └─ retry_count = 3: 终态 FAILED
RUNNING --租约过期(未续期)--> PENDING   # 崩溃回收
```

- **任务级退避**：第 1/2/3 次失败 → now + 3min / 15min / 30min。
- **任务去重创建**：account 存在 `PENDING` / `RUNNING` / 未达上限的 `FAILED` 任务时不新建；仅当无任务、`SUCCESS`、或 `FAILED` 且达上限时才新建 `PENDING`。
- **租约**：默认 5 分钟；Actions 每 30s 续期一次、每次续 3min；RUNNING 且租约过期 → 重置 `PENDING`。
- **两层重试并存**：任务级（账号粒度 3m/15m/30m）与帖子级（现有 pipeline 1m/3m/10m）互不替代。

### 汇总映射
- 全成功 → 任务 `SUCCESS`
- 部分成功(partial) → 任务 `SUCCESS`（已成功帖子已落 `fetched_posts`，失败帖子由帖子级重试兜底，不触发任务级重试）
- 账号整体失败（如列表失败、claim 后异常） → 任务 `FAILED`（走任务级退避）

## 6. 服务端内部 API

本地服务提供、公网可达，均需 worker token 鉴权（Actions 通过 secret 注入）。

| 接口 | 作用 |
|------|------|
| `POST /internal/workers/register` | worker 上线注册 |
| `POST /internal/workers/heartbeat` | 心跳 |
| `POST /internal/tasks/claim` | 事务内挑 PENDING 任务 → 置 RUNNING + 建租约，返回任务或 no_task |
| `POST /internal/tasks/lease/renew` | 续租，返回 ok / lease_lost |
| `POST /internal/posts/result` | 逐条帖子结果 upsert 到 fetched_posts（幂等） |
| `POST /internal/tasks/complete` | 写任务终态 + 更新 accounts 游标/next_run_at + 释放租约 + instar 账号回调（幂等） |

- `claim` 原子完成挑任务+建租约，避免并发抢占。
- 续期丢失（`lease_lost`）后拒绝该任务的后续 `posts/result`。
- `complete` 幂等：任务已终态则直接返回 ok。

## 7. 调度器与唤醒

- `dueScheduler`：不再调用 `listDueAccounts` 后直接抓取；改为 `listDueAccounts` → 按去重规则创建 `PENDING` 任务（无任务账号也创建）→ 调用 `workerWakeService`。
- `workerWakeService`：首版通过 GitHub `workflow_dispatch`（REST API）触发 Actions；**dispatch 去抖**：已有活跃 run 时不重复触发。后续再支持 cron 定时触发。
- 手动触发 `/fetch`：不再进程内直接抓取，改为置账号可领取 + 创建任务，由 worker claim 执行。

## 8. 失败与边界处理

- 续期失败 → 立即停止该账号执行，不再提交结果；租约到期后任务回 `PENDING`。
- 单条帖子失败 → 帖子级退避重试；耗尽标记该 post `failed` 落库，不中断账号。
- worker 崩溃 → 不续期 → 租约到期 → RUNNING 重置 `PENDING`。
- Actions 异步 → 本地 dispatch fire-and-forget，结果只认回调。
- 幂等 → posts/result 靠主键；claim 事务；complete 终态幂等。

## 9. 测试策略

- claim 互斥：并发 claim 同一 PENDING 任务只有一个成功。
- 租约超时回收：停止续期后任务在 TTL 后回 PENDING。
- 续期丢失：lease_lost 后拒绝该任务 posts/result。
- 任务去重创建：五种既有状态分别验证是否新建。
- 任务级退避：失败 retry_count 递增，next_retry_at = +3/+15/+30，到点重置 PENDING；达上限终态。
- 逐条提交：前序成功 post 落库，后续失败不回滚。
- 汇总映射：全成功/partial/全失败 → SUCCESS/SUCCESS/FAILED。
- 空领退出：连续空领达阈值退出。
- 协议一致：local 与 github-action 的 executeAccount 输入输出一致；github-action 不带代理。
- dispatch 去抖：已有活跃 run 时不再触发。

## 10. Spec Patch（已回写 delta spec）

- `worker-execution`：新增「账号级任务模型与状态机」「任务去重创建」；重写「账号级竞争领取与独占租约」为基于 tasks + 租约时长/续期规则；补 github-action 无代理、workflow_dispatch 去抖、空领退出场景。
- `tiktok-fetch-service`：due 调度改为“创建 PENDING 任务而非直接抓取，无任务账号也创建”。

## 11. Open Questions

- worker token 鉴权的具体形式（共享密钥 vs HMAC 签名）在实现阶段定。
- `MAX_EMPTY_ROUNDS` / `IDLE_WAIT` 默认值在实现阶段调参。
- 活跃 run 判定用 GitHub API 查询还是本地记录，在实现阶段定。
