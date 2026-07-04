## Why

`crawler-ins` 将被废弃，`tiktok-downloader` 需要直接承接其与 `instar` 的触发与回调契约，保证上游系统在最小改动下完成从 Instagram 抓取链路到 TikTok 抓取链路的替换。
当前 `tiktok-downloader` 已具备主动触发与周期抓取能力，但接口字段与输出语义与 `crawler-ins` 不一致，需通过适配器层抹平差异。

## What Changes

- 在服务入口兼容 `starId/accountId` 触发语义：`/fetch` 保持现有 HTTP 语义（`202/400`），并接受 `starId` 作为等价账号标识。
- 在账号来源集成层切换为 `instar` 风格列表协议：仅支持 `{ code: 0, data: { list: [{ starId }] } }`。
- 在抓取完成后新增 `instar` webhook 回调适配：发送 `{ starId, token: "instar", status: 1|0 }`，先实现最小契约，不扩展字段。
- 保留并复用现有周期调度与抓取主流程，不改变核心下载/上传流水线语义。
- 更新测试覆盖上述契约兼容路径，确保迁移期间行为可回归。

## Capabilities

### New Capabilities
- `instar-contract-adapter`: 定义并约束 `tiktok-downloader` 对 `instar/crawler-ins` 兼容的触发、账号源解析与完成回调契约。

### Modified Capabilities
- `tiktok-fetch-service`: 扩展服务入口触发参数兼容能力（`starId` 与 `accountId` 对齐）。
- `tiktok-download-scheduler`: 明确账号来源从 `instar` 风格协议读取并纳入周期调度。
- `tiktok-fetch-pipeline`: 增加账号级完成状态回调到 `instar` webhook 的行为约束。

## Impact

- 影响模块：`src/server.ts`、`src/index.ts`、`src/integration/*`、`src/pipeline/*`、`src/config.ts` 与对应测试。
- 对外接口影响：`/fetch` 入参兼容增强（非破坏），新增对 `instar` webhook 回调调用。
- 外部依赖影响：与 `instar-server` 的账号列表与完成回调接口契约建立强耦合（通过适配器隔离）。
- 迁移影响：`instar` 可直接以现有触发习惯驱动 TikTok 抓取，`crawler-ins` 可下线。