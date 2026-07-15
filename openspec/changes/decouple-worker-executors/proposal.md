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
