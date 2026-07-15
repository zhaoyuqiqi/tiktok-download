# Comet Design Handoff

- Change: decouple-worker-executors
- Phase: design
- Mode: compact
- Context hash: 1b3cb0eac3d9e4d18b7405a476e0a009cb3dbc39f514fc40409d54426723c6aa

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/decouple-worker-executors/proposal.md

- Source: openspec/changes/decouple-worker-executors/proposal.md
- Lines: 1-28
- SHA256: 8508dcb99337e31c577a6f409fb4f3fbaca685af641eba638bcb54cca14d3c78

```md
## Why

当前服务里的调度与执行仍然强绑定：调度器在进程内直接调用账号抓取逻辑，导致本地执行、GitHub Actions 执行以及未来更多 worker 形态都无法通过统一协议接入。现有模型也缺少“多个 worker 竞争领取账号任务、账号独占租约、逐条帖子提交结果”的机制，不利于扩展并行执行与失败恢复。

## What Changes

- 新增一个可注册的 worker / executor 能力层：worker 通过统一协议注册、竞争领取账号级任务、续租、逐条上报帖子结果并最终上报账号结果。
- 调度器改为“发现 due account + 唤醒可用 worker”，不再直接把批量账号 payload 下发给执行器，也不再把本地执行硬编码为唯一执行路径。
- 抽离本地执行器到 `workers/local`，新增 `workers/github-action` 作为 pull-based worker；GitHub Actions 只负责启动 worker，worker 启动后自行 claim 可执行账号。
- 为账号领取引入独占租约与超时回收，允许多个已注册 worker 并行竞争领取任务，但同一时刻同一账号只能被一个 worker 持有。
- 调整抓取执行语义：账号内帖子继续逐条处理，且每条帖子同步结果必须逐条提交，后续失败不得回滚此前已成功的帖子结果。
- 统一 worker 输入与输出模型，为未来接入更多 worker 类型保留协议兼容性。

## Capabilities

### New Capabilities
- `worker-execution`: worker 注册、发现、账号级任务竞争领取、租约续约/超时回收、统一 worker 输入输出协议、逐条帖子结果上报与账号汇总结果上报。

### Modified Capabilities
- `tiktok-fetch-service`: 调整服务侧调度职责与内部 API 语义，使服务负责 due 账号发现、worker 唤醒、claim/report/heartbeat 接口与账号级租约控制，而不是在调度器内直接执行抓取。
- `tiktok-fetch-pipeline`: 调整抓取流水线的提交语义，使账号内帖子结果按条落地并逐条同步，账号级完成状态只做汇总，不回滚已成功帖子。

## Impact

- 代码：`src/scheduling/*`、`src/server.ts`、`src/index.ts`、`src/pipeline/accountIngest.ts`、`src/storage/repository.ts`、`src/integration/*`；新增 `workers/local/**`、`workers/github-action/**` 与统一 worker 协议层。
- API：新增或调整内部 worker API（claim / heartbeat / post-result / account-result / wake），手动触发与定时调度将转为复用同一任务领取链路。
- 状态：需要扩展本地持久化，保存 worker 注册信息、账号领取租约、执行状态与逐条帖子结果提交所需的最小状态。
- 运维：新增 GitHub Actions worker 启动流程，但 GitHub Actions 只是 worker 之一，不改变本地服务作为主状态端的职责。
```

## openspec/changes/decouple-worker-executors/design.md

- Source: openspec/changes/decouple-worker-executors/design.md
- Lines: 1-75
- SHA256: 84aabdee3e6f5d3be67af8f40f2ef0ae874517d1f8628dfc659310199d863d4c

```md
## Context

当前实现里，due 调度与手动触发最终都会在服务进程内直接调用账号抓取流程；调度器负责挑账号，也直接承担执行入口。这样虽然能完成本地抓取，但执行模型被固定在“当前进程直接跑”，无法自然演进到多个 worker 并发竞争、GitHub Actions 作为外部 worker、以及未来更多执行形态。

另一方面，现有账号抓取流程已经具备“账号级抓取、帖子级逐条处理、去重与上传”的基础能力，因此这次设计不重写整条流水线，而是在其外侧补一层统一的 worker 协议、账号领取租约与结果回写模型，把“谁来执行”从调度器中剥离出来。

## Goals / Non-Goals

**Goals:**
- 引入可注册的 worker 体系，允许 `[local, github-action, ...]` 多 worker 并行竞争账号任务。
- 调度器只负责发现 due account 并唤醒 worker，不再直接执行业务抓取。
- 同一账号在任一时刻只能被一个 worker 持有，支持租约续期与超时回收。
- 本地 worker 与 GitHub Actions worker 走统一输入输出协议。
- GitHub Actions 采用 pull-based 模式：workflow 只负责启动 worker，不接收批量账号 payload。
- 账号内帖子逐条处理、逐条提交结果，后续失败不影响已成功帖子。
- 保持本地服务为主状态端，由其负责 claim、结果落库、去重推进和最终汇总。

**Non-Goals:**
- 不把 GitHub Actions 变成唯一执行器。
- 不在本次引入外部 MQ、Redis 或分布式锁服务。
- 不彻底重写 `runAccountIngest` 为纯事件溯源模型。
- 不一次性实现除 local / github-action 之外的更多 worker，只保留扩展接口。

## Decisions

- **Decision: 引入独立的 worker-execution 能力层。**
  设计一个独立的 worker 能力，而不是把 GitHub Actions 逻辑塞进现有 scheduler。该能力定义：worker 注册、账号 claim、heartbeat、逐条帖子结果上报、账号汇总结果上报、worker 唤醒。所有 worker 都必须实现同一个抽象基类，抽象基类至少定义统一的 `run()` 方法；注册时直接以 worker class 作为注册值，由注册表统一实例化与调度。这样 local worker 与 github-action worker 都成为同一协议下的实现。
  - 备选方案：继续在现有 scheduler 上加一个 `ExecutionAdapter` 并同步等待远端完成。否决原因：GitHub Actions 天生是异步外部执行，不适合继续伪装成本地同步 `execute()` 模型。

- **Decision: 调度器负责发现与唤醒，不负责下发批量 payload。**
  due 调度继续由本地服务维护 `next_run_at` 与账号活跃度，但它只做两件事：标记有可领取任务、唤醒已注册 worker。worker 自己通过 claim API 拉账号任务。
  - 备选方案：调度器直接把账号列表作为 payload 传给 GitHub Actions。否决原因：重试、恢复和多 worker 竞争都会复杂化，而且用户已明确不要批量 payload。

- **Decision: 使用账号级独占租约而非进程内运行标记。**
  账号级 claim 必须是持久化的，并带有 `lease_expires_at` / heartbeat 续期语义。这样多个 worker 可以并发竞争，但同一账号同一时刻只会被一个 worker 拿到；worker 崩溃时，租约超时后账号可重新领取。
  - 备选方案：继续沿用内存 `runningAccounts`。否决原因：只能约束单进程，无法支持 local 与 GitHub Actions 跨执行器竞争。

- **Decision: 本地 worker 也走统一 claim/report 链路。**
  `workers/local` 不再作为 scheduler 的特殊快捷路径，而是与 github-action worker 一样，继承同一个 worker 抽象基类，并经由统一 claim/report API 和相同输入输出协议执行。这能确保后续新增 worker 时调度器不需要再分支判断，注册表只需要接收新的 worker class。
  - 备选方案：本地保留旧逻辑，只有 GitHub Actions 走新协议。否决原因：会长期保留双轨模型，后续维护成本高。

- **Decision: 账号级领取，帖子级逐条提交。**
  worker 领取的是账号级任务；账号内部仍由现有抓取流水线逐条处理帖子。每条帖子处理完成后立即提交该条结果，由主状态端落库；账号完成时再提交汇总状态(success / partial / failed)。
  - 备选方案：把帖子也拆成全局 claim 单元。否决原因：本次改动面过大，会重写现有账号抓取边界，与用户期望的“两层任务”不一致。

- **Decision: GitHub Actions worker 采用 pull loop。**
  workflow 启动后只负责拉起 github-action worker。worker 在有效运行窗口内循环 claim 账号任务、执行、续租、上报结果，直到无任务或达到预算退出。
  - 备选方案：一次 workflow 只处理固定一批账号。否决原因：与“不要传批量 payload、让 action 内部领取任务”的要求相冲突。

- **Decision: 帖子结果成功即提交，不等待账号结束统一提交。**
  逐条帖子结果一旦成功就立即提交与去重写入。后续帖子失败、账号中断、worker 超时，均不得回滚此前成功帖子。账号级完成只负责汇总本次执行结果。
  - 备选方案：账号结束时统一提交全部帖子结果。否决原因：一旦尾部失败，会把已成功帖子重新暴露给重试，违背用户要求。

## Risks / Trade-offs

- [租约状态存储变复杂] → 只持久化最小必要字段（worker、claim、lease、result summary），避免把完整执行日志塞进主表。
- [本地 worker 走统一链路后，首版重构范围变大] → 优先复用现有抓取编排，只把入口/出口迁到 worker 协议层。
- [GitHub Actions runner 可能很多，竞争过于激进] → 通过 worker 注册、claim 限额、workflow 预算和租约 TTL 控制并发。
- [逐条帖子提交会增加回写频率] → 结果接口采用幂等 upsert，避免重复提交导致状态膨胀。
- [账号部分成功的最终状态定义不清] → 统一定义 success / partial / failed，并在 spec 中明确各场景。

## Migration Plan

1. 先引入持久化的 worker / claim / lease 状态和统一 worker 协议，不改业务抓取核心。
2. 将 local 执行入口抽到 `workers/local`，改为通过 claim/report 执行单账号抓取。
3. 调整 scheduler，使其只发现 due account 并唤醒 worker，不再直接调用旧执行入口。
4. 引入 `workers/github-action` 与 workflow 启动脚本，完成 pull-based claim。
5. 将帖子结果提交改为逐条提交，并补齐部分成功/失败测试。
6. 清理旧的直接执行分支，收敛到统一 worker 协议。

## Open Questions

- worker 注册表首版是否只需要静态配置 + 进程上线心跳，还是需要完整的持久化能力发现。
- GitHub Actions worker 单次运行的 claim 循环预算（时间 / 最大账号数）默认值。
- 账号 `partial` 状态是否需要对外暴露，还是仅内部使用并映射为账号完成失败/成功之一。
```

## openspec/changes/decouple-worker-executors/tasks.md

- Source: openspec/changes/decouple-worker-executors/tasks.md
- Lines: 1-33
- SHA256: ec0e312ce0f67d165c150c4097916dc81b885eeef48335e13f7191061a37eb95

```md
## 1. 持久化与协议建模

- [ ] 1.1 设计并落地 worker 注册、账号 claim 租约与执行结果所需的最小持久化结构
- [ ] 1.2 定义统一的 worker 抽象基类（必须包含 `run()`）以及以 class 为注册值的 worker 注册接口
- [ ] 1.3 为 claim、heartbeat、逐条帖子结果提交和账号汇总结果提交建立幂等规则

## 2. 服务侧 worker API 与调度改造

- [ ] 2.1 在服务侧实现 worker 注册、claim、heartbeat、post-result、account-result 所需的内部 API
- [ ] 2.2 改造 due 调度器，使其只发现 due 账号并唤醒 worker，不再直接执行账号抓取
- [ ] 2.3 将手动触发路径改为复用统一 worker claim 链路，而不是绕过 worker 协议直接执行

## 3. 本地 worker 抽离

- [ ] 3.1 将现有本地执行入口抽离到 `workers/local`，实现统一 worker 抽象基类并适配统一输入输出协议
- [ ] 3.2 让 local worker 通过统一 claim/report 链路执行单账号抓取与结果提交

## 4. GitHub Actions worker 接入

- [ ] 4.1 在 `workers/github-action` 下实现继承统一抽象基类的 pull-based worker，启动后自行 claim 账号任务
- [ ] 4.2 新增或调整 GitHub Actions workflow，使其只负责拉起 github-action worker，不传批量账号 payload
- [ ] 4.3 为 github-action worker 增加运行预算、空闲退出和失败恢复策略

## 5. 抓取流水线逐条提交改造

- [ ] 5.1 调整账号抓取流水线，使帖子按条提交结果并立即持久化成功状态
- [ ] 5.2 实现账号级 success / partial / failed 汇总语义，保证后续失败不回滚前序成功帖子

## 6. 测试与收尾

- [ ] 6.1 补充多 worker 竞争 claim、租约超时回收、同账号互斥的测试
- [ ] 6.2 补充 local / github-action 共用协议、逐条帖子提交、部分成功汇总的测试
- [ ] 6.3 更新 README 或运行说明，描述 worker 注册、GitHub Actions worker 启动方式与调度行为变化
```

## openspec/changes/decouple-worker-executors/specs/tiktok-fetch-pipeline/spec.md

- Source: openspec/changes/decouple-worker-executors/specs/tiktok-fetch-pipeline/spec.md
- Lines: 1-23
- SHA256: 1068ec1e46b36cc2b8c088d9fd9f18ba898f505875c72f2722e99b24a80ce22d

```md
## MODIFIED Requirements

### Requirement: 失败重试与指数退避
系统 SHALL 在单帖子抓取或上传失败时进行重试,最多重试 3 次,重试间隔按指数退避为 1 分钟、3 分钟、10 分钟。超过 3 次仍失败的帖子 SHALL 标记为最终失败,SHALL NOT 影响其他帖子的处理。对于同一账号内已成功并已提交结果的帖子，后续帖子的失败或账号级中断 SHALL NOT 回滚这些已成功帖子。

#### Scenario: 后续失败不影响已提交成功帖子
- **WHEN** 某账号前序帖子已成功抓取并提交结果，后续帖子在重试耗尽后失败
- **THEN** 前序成功帖子保持成功状态，失败帖子标记为最终失败

### Requirement: 成功后回传适配层
系统 SHALL 在单账号抓取过程中按帖子粒度提交结果：每条帖子在抓取、上传与同步完成后 SHALL 立即提交该条结果，再继续处理下一条帖子。账号级完成回调 SHALL 仅在该账号处理结束后提交汇总状态，用于反映本次账号执行的整体结果；账号级完成回调 SHALL NOT 取代逐条帖子提交，也 SHALL NOT 回滚已成功帖子。

#### Scenario: 逐条帖子提交结果
- **WHEN** 某账号抓取流程处理完一条帖子且该帖成功同步
- **THEN** 系统立即提交该条帖子的成功结果，然后继续处理该账号的下一条帖子

#### Scenario: 账号结束时提交汇总状态
- **WHEN** 某账号的全部帖子都已处理完成（无论结果全成功或部分失败）
- **THEN** 系统再提交一次账号级汇总状态，表示该账号本次执行为 success、partial 或 failed

#### Scenario: 汇总失败不回滚帖子结果
- **WHEN** 账号级汇总回调失败，但部分帖子结果此前已成功提交
- **THEN** 已成功提交的帖子结果仍然保留，不因账号级汇总失败被回滚
```

## openspec/changes/decouple-worker-executors/specs/tiktok-fetch-service/spec.md

- Source: openspec/changes/decouple-worker-executors/specs/tiktok-fetch-service/spec.md
- Lines: 1-34
- SHA256: 10bb6a6b8c84ad500ed2dc296cd2e198dade8f44f8592f2afdd219c62ce1b2d2

```md
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
系统 SHALL 以 due 时间驱动进行调度:每个账号在本地持久化一个下次到期时间 `next_run_at`。调度 tick 到达时,系统 SHALL 仅挑选 `next_run_at` 已到期且处于 active 的账号进入可领取状态,并根据已注册 worker 情况执行唤醒/调度动作。调度器 SHALL NOT 直接把整批账号 payload 下发给执行器；worker SHALL 自行通过 claim 协议拉取可执行账号。

#### Scenario: 调度器只唤醒 worker 不下发账号列表
- **WHEN** 某一轮调度发现存在 due 账号
- **THEN** 调度器只执行 worker 唤醒或调度动作，不直接向 worker 传递账号批量 payload

#### Scenario: worker 自行拉取 due 账号
- **WHEN** 调度器唤醒了一个 github-action worker
- **THEN** 该 worker 通过 claim 协议自行领取 due 账号，而不是消费调度器直推的账号列表
```

## openspec/changes/decouple-worker-executors/specs/worker-execution/spec.md

- Source: openspec/changes/decouple-worker-executors/specs/worker-execution/spec.md
- Lines: 1-60
- SHA256: 32894d275d37c90dae0c40b41e5409b0b91400dc902dc540e3ebbcfcc7ff4442

```md
## ADDED Requirements

### Requirement: Worker 注册与发现
系统 SHALL 支持多个 worker 类型通过统一能力注册到服务侧。每个 worker 实例 SHALL 具有稳定的 `worker_type`、`worker_id` 与可观测的存活状态。服务 SHALL 能基于注册信息识别当前可参与领取任务的 worker 集合，首批至少支持 `local` 与 `github-action` 两种 worker 类型。

#### Scenario: 多个 worker 同时注册
- **WHEN** `local` 与 `github-action` 两类 worker 都已注册
- **THEN** 服务将它们都视为可参与领取任务的 worker

#### Scenario: 同类型多实例注册
- **WHEN** 同一 worker 类型存在多个实例（如多个 github-action runner）
- **THEN** 服务为每个实例分配独立 `worker_id` 并分别跟踪其可用状态

### Requirement: 账号级竞争领取与独占租约
系统 SHALL 允许多个已注册 worker 并行竞争领取 due 账号任务。账号任务 SHALL 以账号为最小 claim 单元；同一时刻同一账号 SHALL 只允许被一个 worker 成功领取。成功领取后，系统 SHALL 为该账号建立带过期时间的独占租约；worker SHALL 通过 heartbeat 续租。租约超时或 worker 异常退出后，系统 SHALL 允许其他 worker 重新领取该账号。

#### Scenario: 多 worker 竞争同一账号
- **WHEN** 两个 worker 同时尝试领取同一个 due 账号
- **THEN** 只有一个 worker 领取成功，另一个 worker 不会得到该账号

#### Scenario: 租约有效期间不重复领取
- **WHEN** 某账号已被 worker 成功领取且租约仍有效
- **THEN** 其他 worker 无法再次领取该账号

#### Scenario: worker 崩溃后账号重新可领
- **WHEN** 某 worker 在持有账号租约期间崩溃，且未继续 heartbeat
- **THEN** 租约到期后该账号重新变为可领取状态

### Requirement: 统一 worker 输入与输出协议
系统 SHALL 为所有 worker 类型提供统一的账号级输入与结果输出协议。worker 的输入 SHALL 至少包含账号标识、平台、执行来源、必要的抓取参数与 claim 元数据；worker 的输出 SHALL 同时支持逐条帖子结果上报与账号汇总结果上报。调度器与服务侧 SHALL 仅依赖该统一协议，而不依赖具体 worker 类型的内部实现。

#### Scenario: local 与 github-action 共享同一协议
- **WHEN** local worker 与 github-action worker 各自领取一个账号任务
- **THEN** 两者收到的账号级输入结构一致，提交结果时使用同一输出结构

#### Scenario: 新增第三种 worker 不修改调度协议
- **WHEN** 后续新增新的 worker 类型
- **THEN** 只要其实现统一输入输出协议，调度器无需修改任务分发契约

### Requirement: Pull-based GitHub Actions Worker
系统 SHALL 将 GitHub Actions 作为 pull-based worker 使用。调度器或服务侧唤醒 GitHub Actions 时 SHALL NOT 下发批量账号 payload；workflow 启动后，github-action worker SHALL 自行通过统一 claim 协议领取账号任务并执行。

#### Scenario: workflow 启动后自行领取任务
- **WHEN** 调度器唤醒一次 GitHub Actions worker
- **THEN** 该 worker 启动后自行向服务侧 claim 可执行账号，而不是消费调度器下发的账号列表

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
```

