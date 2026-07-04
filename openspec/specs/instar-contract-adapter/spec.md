# instar-contract-adapter Specification

## Purpose
TBD - created by archiving change align-tiktok-with-crawler-ins-contract. Update Purpose after archive.
## Requirements
### Requirement: Instar 触发字段适配
系统 SHALL 在服务入口支持 `starId` 与 `accountId` 两种触发字段。请求中两者至少提供其一;当两者同时存在时,系统 SHALL 优先使用 `accountId` 作为内部统一账号标识,并将 `starId` 视为兼容输入。接口响应 SHALL 维持既有 HTTP 语义(成功 `202`,参数非法 `400`)。

#### Scenario: 使用 starId 触发抓取
- **WHEN** 外部请求 `POST /fetch` 且仅提供 `starId`
- **THEN** 系统受理请求并将 `starId` 映射为内部账号标识入队,返回 `202`

#### Scenario: 参数缺失
- **WHEN** 外部请求 `POST /fetch` 且 `accountId` 与 `starId` 均缺失或为空
- **THEN** 系统返回 `400` 参数错误,且不触发任何抓取

### Requirement: Instar 账号列表协议解析
系统 SHALL 仅支持解析 `instar` 风格账号列表协议:`{ code: 0, data: { list: [{ starId }] } }`。当响应结构不匹配、`code` 非 `0`、或 `starId` 缺失/为空时,系统 SHALL 将该次对账视为失败并上报错误;系统 SHALL NOT 使用其他历史兼容格式(`string[]` 或 `{accounts:string[]}`)。

#### Scenario: 解析标准 instar 响应
- **WHEN** 账号源接口返回 `{ code: 0, data: { list: [{ starId: "abc" }] } }`
- **THEN** 系统解析出账号列表 `["abc"]` 并进入对账流程

#### Scenario: 非法结构拒绝
- **WHEN** 账号源接口返回结构不符合 `code/data/list/starId`
- **THEN** 系统报错并终止本轮对账,不更新本地账号状态

### Requirement: Instar 完成回调最小契约
系统 SHALL 在单账号抓取流程结束后向 `instar` webhook 发送账号级完成状态回调,请求体 SHALL 为 `{ starId, token: "instar", status }`,其中成功时 `status=1`,失败时 `status=0`。系统 SHALL 不在本次契约中发送扩展字段。

#### Scenario: 成功回调
- **WHEN** 某账号抓取流程成功完成
- **THEN** 系统向 webhook 发送 `{starId, token:"instar", status:1}`

#### Scenario: 失败回调
- **WHEN** 某账号抓取流程最终失败
- **THEN** 系统向 webhook 发送 `{starId, token:"instar", status:0}`

