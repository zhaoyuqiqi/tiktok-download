## MODIFIED Requirements

### Requirement: Elysia Web 服务形态
系统 SHALL 继续以基于 Elysia 的常驻 Web 服务形式运行，并在原有手动触发与状态查询能力之外，提供供 worker 使用的内部任务 API。该内部 API SHALL 支持 worker 注册、账号 claim、heartbeat、逐条帖子结果提交与账号汇总结果提交。手动触发与定时调度 SHALL 复用同一任务领取链路，而不是绕过 worker 协议直接执行抓取。

#### Scenario: worker 通过内部 API 领取任务
- **WHEN** 任一已注册 worker 启动后请求领取任务
- **THEN** 服务通过内部 API 返回一个可执行的账号任务或明确表示当前无任务

#### Scenario: 手动触发不绕过 worker 协议
- **WHEN** 外部通过 HTTP 主动触发抓取某账号
- **THEN** 服务将该账号置为可领取状态，并由某个 worker 经统一 claim 协议领取执行，而不是在触发请求内直接跑抓取

### Requirement: 并发限制与同账号串行
系统 SHALL 限制全局并发抓取数量,默认上限为 2 且 SHALL 可配置。系统 SHALL 保证同一账号的抓取串行执行,SHALL NOT 对同一账号并行抓取。该串行保证 SHALL 通过持久化的账号领取租约实现，并适用于多个 worker 并行竞争的场景，而不仅限于单进程内存占用。

#### Scenario: 多 worker 下同账号仍串行
- **WHEN** 多个 worker 并行竞争领取账号任务
- **THEN** 同一账号在任一时刻仍只会被一个 worker 执行

#### Scenario: 租约超时后重新领取
- **WHEN** 某账号已被某 worker 领取，但该 worker 未在租约过期前续租
- **THEN** 服务允许其他 worker 重新领取该账号

### Requirement: due 驱动调度
系统 SHALL 以 due 时间驱动进行调度:每个账号在本地持久化一个下次到期时间 `next_run_at`。调度 tick 到达时,系统 SHALL 仅挑选 `next_run_at` 已到期且处于 active 的账号。对每个到期账号,调度器 SHALL NOT 直接发起抓取,而是按任务去重创建规则为其创建 `PENDING` 账号任务(当该账号没有任务时也创建),再根据已注册 worker 情况执行唤醒/调度动作。调度器 SHALL NOT 直接把整批账号 payload 下发给执行器；worker SHALL 自行通过 claim 协议拉取 `PENDING` 任务执行。

#### Scenario: 调度器创建任务而非直接抓取
- **WHEN** 某一轮调度挑选出到期账号
- **THEN** 调度器按去重创建规则为这些账号创建 PENDING 任务，而不是直接对其发起抓取

#### Scenario: 无任务账号也创建任务
- **WHEN** 某到期账号当前没有任何任务
- **THEN** 调度器为其创建一个 PENDING 任务

#### Scenario: 调度器只唤醒 worker 不下发账号列表
- **WHEN** 某一轮调度已创建可执行的 PENDING 任务
- **THEN** 调度器只执行 worker 唤醒或调度动作，不直接向 worker 传递账号批量 payload

#### Scenario: worker 自行拉取任务
- **WHEN** 调度器唤醒了一个 github-action worker
- **THEN** 该 worker 通过 claim 协议自行领取 PENDING 任务执行，而不是消费调度器直推的账号列表
