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
