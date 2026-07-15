## ADDED Requirements

### Requirement: Worker 注册与发现
系统 SHALL 支持多个 worker 类型通过统一能力注册到服务侧。每个 worker 实例 SHALL 具有稳定的 `worker_type`、`worker_id` 与可观测的存活状态。服务 SHALL 能基于注册信息识别当前可参与领取任务的 worker 集合，首批至少支持 `local` 与 `github-action` 两种 worker 类型。

#### Scenario: 多个 worker 同时注册
- **WHEN** `local` 与 `github-action` 两类 worker 都已注册
- **THEN** 服务将它们都视为可参与领取任务的 worker

#### Scenario: 同类型多实例注册
- **WHEN** 同一 worker 类型存在多个实例（如多个 github-action runner）
- **THEN** 服务为每个实例分配独立 `worker_id` 并分别跟踪其可用状态

### Requirement: 账号级任务模型与状态机
系统 SHALL 使用账号级任务作为执行调度的最小单元，并持久化任务。每个任务 SHALL 至少包含 `id`、`account`、`status`、`retry_count`、`next_retry_at` 字段。`status` SHALL 取值于 `PENDING`、`RUNNING`、`SUCCESS`、`FAILED`。`retry_count` 默认值 SHALL 为 `0`，最大值 SHALL 为 `3`。任务级失败重试 SHALL 按指数退避设置 `next_retry_at`：第 1、2、3 次失败分别为当前时间 +3 分钟、+15 分钟、+30 分钟。当任务状态由 `RUNNING` 变为 `FAILED` 且 `retry_count` 未达最大值时，系统 SHALL 在到达 `next_retry_at` 后将其从 `FAILED` 重置为 `PENDING` 以供重新拾取；当 `retry_count` 达到最大值时，`FAILED` SHALL 为终态。

#### Scenario: 任务失败按指数退避重置为可重试
- **WHEN** 某账号任务由 RUNNING 变为 FAILED 且 retry_count 未达最大值 3
- **THEN** 系统按 +3/+15/+30 分钟设置 next_retry_at，并在到达该时间后将该任务从 FAILED 重置为 PENDING

#### Scenario: 达到最大重试次数后为终态失败
- **WHEN** 某账号任务失败且 retry_count 已达最大值 3
- **THEN** 该任务保持 FAILED 终态，不再重置为 PENDING

### Requirement: 任务去重创建
系统 SHALL 在为某账号创建任务前检查该账号已有任务的状态，避免重复创建并发任务。当该账号存在 `PENDING`、`RUNNING`，或 `FAILED` 且 `retry_count` 未达最大值的任务时，系统 SHALL NOT 为其创建新任务。仅当该账号没有任务、已有任务为 `SUCCESS`、或已有任务为 `FAILED` 且 `retry_count` 已达最大值时，系统 SHALL 允许创建新的 `PENDING` 任务。

#### Scenario: 存在进行中或可重试任务时不新建
- **WHEN** 某账号已存在 PENDING、RUNNING，或 FAILED 且未达最大重试次数的任务
- **THEN** 系统不为该账号创建新任务

#### Scenario: 无任务时创建新任务
- **WHEN** 某到期账号当前没有任何任务
- **THEN** 系统为其创建一个 PENDING 任务

#### Scenario: 终态后允许创建新任务
- **WHEN** 某账号已有任务为 SUCCESS，或为 FAILED 且已达最大重试次数
- **THEN** 系统允许为该账号创建新的 PENDING 任务

### Requirement: 账号级竞争领取与独占租约
系统 SHALL 允许多个已注册 worker 并行竞争领取 `PENDING` 账号任务。账号任务 SHALL 以账号为最小 claim 单元；同一时刻同一账号 SHALL 只允许被一个 worker 成功领取。成功领取后，系统 SHALL 将任务置为 `RUNNING` 并为其建立带过期时间的独占租约，默认租约时长 SHALL 为 5 分钟；worker SHALL 通过 heartbeat 续租，Actions 环境下每次续租 SHALL 延长 3 分钟且续租间隔 SHALL 为 30 秒。当任务处于 `RUNNING` 且租约过期（worker 未按时续租）时，系统 SHALL 将该任务重置为 `PENDING` 以供下次拾取。

#### Scenario: 多 worker 竞争同一账号
- **WHEN** 两个 worker 同时尝试领取同一个 PENDING 账号任务
- **THEN** 只有一个 worker 领取成功并将任务置为 RUNNING，另一个 worker 不会得到该账号

#### Scenario: 租约有效期间不重复领取
- **WHEN** 某账号任务已被 worker 领取为 RUNNING 且租约仍有效
- **THEN** 其他 worker 无法再次领取该账号任务

#### Scenario: 租约过期后 RUNNING 重置为 PENDING
- **WHEN** 某账号任务处于 RUNNING 且其租约已过期，worker 未继续续租
- **THEN** 系统将该任务重置为 PENDING，使其可被重新领取

### Requirement: 统一 worker 输入与输出协议
系统 SHALL 为所有 worker 类型提供统一的账号级输入与结果输出协议。worker 的输入 SHALL 至少包含账号标识、平台、执行来源、必要的抓取参数与 claim 元数据；worker 的输出 SHALL 同时支持逐条帖子结果上报与账号汇总结果上报。调度器与服务侧 SHALL 仅依赖该统一协议，而不依赖具体 worker 类型的内部实现。

#### Scenario: local 与 github-action 共享同一协议
- **WHEN** local worker 与 github-action worker 各自领取一个账号任务
- **THEN** 两者收到的账号级输入结构一致，提交结果时使用同一输出结构

#### Scenario: 新增第三种 worker 不修改调度协议
- **WHEN** 后续新增新的 worker 类型
- **THEN** 只要其实现统一输入输出协议，调度器无需修改任务分发契约

#### Scenario: github-action worker 执行体与本地一致但不使用代理
- **WHEN** github-action worker 在 Actions 环境执行某账号抓取
- **THEN** 其抓取与逐条提交行为与本地 worker 一致，但不使用代理

### Requirement: Pull-based GitHub Actions Worker
系统 SHALL 将 GitHub Actions 作为 pull-based 的临时计算节点使用。首版唤醒方式 SHALL 为本地服务通过 GitHub `workflow_dispatch` 主动触发，且触发时 SHALL NOT 下发批量账号 payload。为避免重复拉起，本地触发 SHALL 做去抖：当已存在活跃的 GitHub Actions run 时 SHALL NOT 再次触发新的 run。workflow 启动后，github-action worker SHALL 自行通过统一 claim 协议领取账号任务并执行；github-action worker 的执行体行为 SHALL 与本地 worker 一致，但 SHALL NOT 使用代理。github-action worker SHALL 在有任务时立即抽干（处理完一个立即领取下一个），在无任务时按固定间隔续期心跳并在连续空领达到阈值后退出；系统 SHALL NOT 对 github-action worker 设置应用层最大运行时长上限。

#### Scenario: 本地 workflow_dispatch 触发且不下发账号
- **WHEN** 调度器检测到存在可执行账号任务且当前无活跃 GitHub Actions run
- **THEN** 本地服务通过 workflow_dispatch 触发一次 run，且不在触发中携带账号批量 payload

#### Scenario: 已有活跃 run 时去抖不重复触发
- **WHEN** 已存在一个活跃的 GitHub Actions run，此时又检测到可执行账号任务
- **THEN** 本地服务不再触发新的 run，由已在运行的 worker 继续抽取任务

#### Scenario: workflow 启动后自行领取任务
- **WHEN** 一次 GitHub Actions run 已启动
- **THEN** 该 worker 自行向服务侧 claim 可执行账号，而不是消费调度器下发的账号列表

#### Scenario: 无任务时连续空领后退出
- **WHEN** github-action worker 连续多次 claim 均无可执行任务并达到空领阈值
- **THEN** 该 worker 结束本次运行退出，不长期空转

#### Scenario: GitHub Actions 只是 worker 之一
- **WHEN** 本地 local worker 与 GitHub Actions worker 同时可用
- **THEN** 两者都可参与竞争领取账号任务，系统不将 GitHub Actions 视为唯一执行器

### Requirement: 逐条帖子结果提交与账号汇总提交
worker 在执行单账号抓取时，系统 SHALL 要求其对账号内帖子逐条提交结果。某条帖子一旦成功提交，后续帖子失败、账号中断或 worker 退出 SHALL NOT 回滚该条已成功结果。账号全部处理结束后，worker SHALL 再提交一次账号汇总结果，用于标记本次执行是 `success`、`partial` 或 `failed`。

#### Scenario: 后续帖子失败不回滚前序成功帖子
- **WHEN** 一个账号前两条帖子已成功提交，第 3 条帖子失败
- **THEN** 前两条帖子的成功结果仍然保留，不因第 3 条失败被回滚

#### Scenario: 账号部分成功
- **WHEN** 一个账号在本次执行中既有成功帖子也有失败帖子
- **THEN** worker 最终提交的账号汇总结果为 `partial`
