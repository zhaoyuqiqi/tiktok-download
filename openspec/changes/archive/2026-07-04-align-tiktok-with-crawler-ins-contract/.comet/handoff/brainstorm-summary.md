# Brainstorm Summary

- Change: align-tiktok-with-crawler-ins-contract
- Date: 2026-07-04

## 确认的技术方案

- 目标：`tiktok-downloader` 替代 `crawler-ins`，通过适配器抹平与 `instar` 的契约差异。
- `/fetch` 保留现有 HTTP 语义（`202/400`），并兼容 `starId/accountId`。
- 账号列表来源仅支持 `instar` 协议：`{ code: 0, data: { list: [{ starId }] } }`。
- 完成回调采用账号级最小契约，且**每次账号任务结束回调 1 次**：`{ starId, token: "instar", status: 1|0 }`。
- 回调失败策略：**本期不重试**，仅记录错误并继续主流程（先可用）。

## 关键取舍与风险

- 取舍：在服务边界做兼容映射，不侵入核心抓取流水线。
- 取舍：回调失败不重试，换取实现简单与上线速度。
- 风险：回调失败时与 `instar` 状态可能短时不一致。
- 风险：上游账号列表协议若变更会导致对账失败。

## 测试策略

- `/fetch` 入参兼容测试（`accountId`、`starId`、缺失字段）。
- 账号列表协议解析测试（正确结构、`code!=0`、结构错误、空 `starId`）。
- 账号级完成回调测试（成功 `status=1`、失败 `status=0`、每次任务结束仅一次）。

## Spec Patch

- 暂无新增 patch；当前 delta spec 已覆盖关键契约。
