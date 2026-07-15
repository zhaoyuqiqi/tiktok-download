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
