---
comet_change: align-tiktok-with-crawler-ins-contract
role: technical-design
canonical_spec: openspec
status: final
archived-with: 2026-07-04-align-tiktok-with-crawler-ins-contract
status: final
---

# TikTok 替代 crawler-ins 契约对齐设计

## Context

目标是让 `tiktok-downloader` 在不侵入核心抓取流水线的前提下，替代 `crawler-ins` 对接 `instar-server`。本次以边界适配为主：
- `POST /fetch` 兼容 `starId/accountId`，保持既有 HTTP 语义（`202/400`）。
- 周期账号源仅支持 instar 协议：`{ code: 0, data: { list: [{ starId }] } }`。
- 账号级完成回调统一为 `{ starId, token: "instar", status: 1|0 }`。

## Goals / Non-Goals

**Goals**
- 通过边界适配抹平与 `crawler-ins` 的触发与回调契约差异。
- 保持现有调度、抓取、上传主流程稳定。
- 每次账号任务结束都回调一次（成功 `1`、失败 `0`）。
- 回调失败不重试，仅记录日志，先保证可用替换。

**Non-Goals**
- 不迁移历史 Instagram 数据。
- 不保留 `crawler-ins` 运行链路。
- 不在本次加入回调扩展字段或补偿重试机制。

## Architecture Decisions

### D1：边界适配，不改核心流水线（采用）
在 `server`、`integration`、`scheduler/pipeline` 连接点做字段映射与契约转换；`Store`、`FetchPipeline` 核心过程只做最小接线。

### D2：`/fetch` 输入兼容，响应语义不变（采用）
请求体接受 `accountId` 或 `starId`，内部归一为账号标识后入队；继续返回 `202/400`。

### D3：账号源客户端严格 instar 协议（采用）
仅解析 `{code:0,data:{list:[{starId}]}}`；`code != 0`、结构异常、空 `starId` 均判定失败并记录。

### D4：账号级完成回调固定最小负载（采用）
账号任务结束统一触发一次 webhook：`{starId, token:"instar", status:1|0}`。失败仅日志，不阻断抓取主流程。

## Integration Points

- `src/server.ts`：`/fetch` 兼容入参解析和归一化。
- `src/integration/accountSourceClient.ts`：账号列表协议切换为 instar 格式。
- `src/integration/instarServer.ts`：账号级完成回调客户端。
- `src/pipeline/accountIngest.ts` / `src/index.ts`：任务结束回调接入点（成功/失败均触发）。

## Error Handling

- 回调失败：只记错误日志，不重试。
- 账号列表解析失败：本轮同步失败，不写入无效数据。
- `/fetch` 参数缺失：返回 `400`。

## Testing Strategy

- `/fetch`：`accountId`、`starId`、双字段、缺失字段四类输入测试。
- 账号源：instar 协议成功路径与异常路径（`code!=0`、结构错误、空 `starId`）。
- 回调：成功/失败任务各触发一次，payload 严格匹配 `status 1|0`。
- 回归：`bunx tsc --noEmit`、`bun test`。

## Risks / Trade-offs

- 回调失败不重试会带来短时状态不一致；当前以“先可用”优先。
- 严格协议会降低兼容性，但能尽早暴露上游契约漂移。

## Open Questions

- 回调失败补偿（重试/队列）是否在后续迭代纳入。
- 回调字段是否需要扩展（如 `platform/error/traceId`）。
