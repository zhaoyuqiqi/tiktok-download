## Context

当前 `tiktok-downloader` 已具备以下能力：
- 常驻服务并暴露 `POST /fetch`、`GET /status`。
- 周期拉取账号名单并执行 due 调度抓取。
- 抓取成功后可走上传与回传抽象层。

但它与将被替代的 `crawler-ins` 契约存在三类差异：
1. 触发字段差异（`accountId` vs `starId`）。
2. 账号源协议差异（当前支持 `string[]/{accounts}`，目标只认 `instar` 风格 `code/data/list`）。
3. 完成回调差异（当前是帖子级抽象回传，目标是账号级 `{starId, token, status}`）。

迁移目标是让 `instar` 在最小改造下把抓取执行者从 `crawler-ins` 切换为 `tiktok-downloader`，且不破坏现有 TikTok 核心抓取流水线。

## Goals / Non-Goals

**Goals:**
- 在 `tiktok-downloader` 内提供与 `crawler-ins` 对齐的契约适配层。
- `POST /fetch` 保持 `202/400` HTTP 语义，同时兼容 `starId/accountId`。
- 周期账号拉取仅支持 `instar` 风格 `{code:0,data:{list:[{starId}]}}`。
- 账号级抓取完成后回调 `instar` webhook，负载先固定为 `{starId, token:"instar", status:1|0}`。
- 适配逻辑与核心抓取逻辑解耦，便于后续删除兼容层或扩展字段。

**Non-Goals:**
- 不迁移历史 Instagram 抓取数据。
- 不保留 `crawler-ins` 的 GitHub Actions 触发链路。
- 不在本次定义扩展回调字段（如错误码、平台字段）。
- 不在本次实现完整 `instar` 账号列表服务端（仅定义客户端消费契约）。

## Decisions

### Decision 1: 采用“边界适配器”而非改写核心抓取流水线
- **选择**：在 `server` 与 `integration` 边界做字段映射和协议适配，核心调度/抓取/上传流程保持不变。
- **原因**：最小改动、回归风险低；未来移除兼容层只需删边界逻辑。
- **备选**：将 `starId` 深入替换为内部主标识。该方案侵入面大，会扩大测试与迁移成本。

### Decision 2: `/fetch` 兼容输入但保持现有 HTTP 语义
- **选择**：请求体接受 `accountId` 或 `starId`（至少一个），内部统一归一为 `accountId` 执行；响应继续使用 `202/400`。
- **原因**：符合用户确认的协议，且与现有客户端测试和运行行为兼容。
- **备选**：统一改为 `HTTP 200 + code/msg/data` 包装，需改动调用方和现有测试，收益不足。

### Decision 3: 账号列表客户端切换为严格 instar 协议
- **选择**：账号源客户端仅接受 `{ code:0, data:{ list:[{starId}] } }`，解析失败即报错。
- **原因**：用户明确要求只支持该格式，可提前暴露契约漂移，避免“看似成功但数据空”。
- **备选**：多协议兼容解析。短期灵活但会掩盖上游协议偏差，增加维护复杂度。

### Decision 4: 完成回调下沉到账号级状态钩子
- **选择**：在账号抓取流程结束处（成功/失败）发送一次 webhook：`{starId, token:"instar", status:1|0}`。
- **原因**：与 `crawler-ins` 现网回调语义一致，满足迁移最小闭环。
- **备选**：继续帖子级回传。与目标契约不一致，`instar` 侧无法无缝复用原处理逻辑。

### Decision 5: 使用显式配置驱动 webhook 行为
- **选择**：新增配置项控制 webhook URL/token/启停，默认可关闭或使用 noop 客户端。
- **原因**：便于本地开发与灰度，避免硬编码导致环境耦合。
- **备选**：直接硬编码生产地址。不可测试且有误调用风险。

## Risks / Trade-offs

- **[风险] 上游 `instar` 账号列表字段名变化（`starId` 改名）** → **缓解**：在解析错误日志中输出结构诊断，并在测试中锁定 schema。
- **[风险] webhook 短暂失败导致状态未同步** → **缓解**：先按最小语义实现失败可见日志，后续迭代增加重试策略（本次不纳入）。
- **[权衡] 保持 202/400 语义会与 `instar` 统一包装风格不一致** → **缓解**：在接口文档中明确该端点语义，并通过入参兼容降低改造成本。
- **[权衡] 仅支持 instar 单协议降低兼容性** → **缓解**：通过适配器集中控制，若未来需扩展可在单点增加分支解析。

## Migration Plan

1. 增加并落地 `instar` 契约适配层（输入映射、账号源解析、完成回调客户端）。
2. 更新 `server`、`index`、`pipeline/scheduler` 连接点，确保账号级完成时触发 webhook。
3. 补齐单测与集成测试：
   - `/fetch` 的 `starId/accountId` 兼容路径。
   - 账号列表 instar 协议解析与异常路径。
   - 成功/失败回调 payload 为 `status 1/0`。
4. 本地与 CI 验证（`bun test`、`bunx tsc --noEmit`）。
5. 灰度切换：先由 `instar` 指向新 `/fetch` 与账号列表接口，再下线 `crawler-ins`。

回滚策略：关闭 webhook 配置并回退到上一版本，`instar` 可临时恢复旧触发链路（若仍保留）。

## Open Questions

- `instar` 账号列表接口的鉴权方式是否固定为 Bearer（当前按配置支持）。
- webhook 调用失败是否需要“至少一次”送达保证（本次仅记录失败，不重试）。
- 未来是否在完成回调中补充扩展字段（例如错误码、traceId）。