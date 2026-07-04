# Comet Design Handoff

- Change: align-tiktok-with-crawler-ins-contract
- Phase: design
- Mode: compact
- Context hash: 22293e0cc81975ea1ca28a2b5f3b243a6c80f5f7a53056a41efe90b9a6054e47

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/align-tiktok-with-crawler-ins-contract/proposal.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/proposal.md
- Lines: 1-28
- SHA256: 93772529e5528329ceed3e627bf4ac69a43f95509a62e732ad658d035da813a7

```md
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
- 迁移影响：`instar` 可直接以现有触发习惯驱动 TikTok 抓取，`crawler-ins` 可下线。```

## openspec/changes/align-tiktok-with-crawler-ins-contract/design.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/design.md
- Lines: 1-80
- SHA256: 8002f150423dbbb3ee7fc73511cefa300b89bcc737352fbbf0c7380a5c900bf6

```md
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
- 未来是否在完成回调中补充扩展字段（例如错误码、traceId）。```

## openspec/changes/align-tiktok-with-crawler-ins-contract/tasks.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/tasks.md
- Lines: 1-22
- SHA256: 3ae0a2bb678cbfdf7caa6b1e2752659ec38ccbb7c81467ebd79ba6af4d7fa219

```md
## 1. 接口与契约适配

- [ ] 1.1 改造 `POST /fetch` 入参解析: 支持 `starId/accountId` 二选一,保持 `202/400` 语义与现有响应结构
- [ ] 1.2 为 `server` 层补充 `starId` 兼容路径测试(仅 starId、双字段、缺失字段)
- [ ] 1.3 增加账号标识归一化工具,统一在服务边界将 `starId` 映射为内部账号标识

## 2. 账号列表来源切换为 instar 协议

- [ ] 2.1 改造账号来源客户端,仅解析 `{code:0,data:{list:[{starId}]}}`
- [ ] 2.2 对非法结构、`code!=0`、空 `starId` 增加失败测试并确保本轮对账不落库
- [ ] 2.3 更新配置与文档说明,明确账号列表接口契约与鉴权用法

## 3. 抓取完成回调适配

- [ ] 3.1 新增 `instar` 完成回调客户端(账号级),发送 `{starId, token:"instar", status:1|0}`
- [ ] 3.2 在账号抓取成功/失败结束处接入回调调用,不影响抓取与去重主流程
- [ ] 3.3 为成功与失败回调路径补充测试,验证 payload 与触发时机

## 4. 集成验证与迁移收尾

- [ ] 4.1 运行并修复类型检查与测试(`bunx tsc --noEmit`、`bun test`)
- [ ] 4.2 追加迁移说明: `instar` 如何改调 `/fetch` 与账号列表接口,以及 `crawler-ins` 下线步骤
- [ ] 4.3 回归校验 `/status` 与周期调度行为未被本次适配破坏```

## openspec/changes/align-tiktok-with-crawler-ins-contract/specs/instar-contract-adapter/spec.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/specs/instar-contract-adapter/spec.md
- Lines: 1-33
- SHA256: c4113f52edc5fe9f6e6fc24b5c5236246f3d5d43700a536780554058bd25b9ca

```md
## ADDED Requirements

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
- **THEN** 系统向 webhook 发送 `{starId, token:"instar", status:0}````

## openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-download-scheduler/spec.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-download-scheduler/spec.md
- Lines: 1-23
- SHA256: 465706289155513fd713ee144fe97dfb2cbd39798684a5c766ea2c999e06d126

```md
## MODIFIED Requirements

### Requirement: 外部账号名单对账
系统 SHALL 通过外部 HTTP 接口获取待抓账号名单(权威源),并定期(间隔由环境变量配置,默认 5 分钟)与本地 SQLite 对账。外部接口响应 SHALL 使用 `instar` 协议格式:`{ code: 0, data: { list: [{ starId }] } }`。对账循环 SHALL 只处理账号名单,SHALL NOT 触发 yt-dlp 抓取。对账时:新增账号 SHALL 被插入并置 `next_run_at` 为当前时间(可加随机 jitter 打散);已存在账号 SHALL 保留其 `next_run_at` 与 `last_post_at` 不被覆盖;外部名单中已移除的账号 SHALL 被标记为 inactive 停止调度,并保留其去重历史。

#### Scenario: 新增账号进入调度
- **WHEN** 对账发现外部名单中存在本地没有的账号
- **THEN** 系统插入该账号并置 `next_run_at` 为当前时间(带 jitter),使其在后续 tick 被挑到

#### Scenario: 已存在账号不重置调度状态
- **WHEN** 对账时某账号已存在于本地
- **THEN** 系统不覆盖其 `next_run_at` 与 `last_post_at`

#### Scenario: 已移除账号停止调度
- **WHEN** 某账号不再出现在外部名单中
- **THEN** 系统将其标记为 inactive 不再调度,但保留其去重历史

#### Scenario: 对账不触发抓取
- **WHEN** 执行一次名单对账
- **THEN** 系统只更新账号名单与状态,不发起任何 yt-dlp 抓取

#### Scenario: 仅接受 instar 协议列表
- **WHEN** 外部接口返回的账号列表不符合 `{code:0,data:{list:[{starId}]}}`
- **THEN** 本轮对账失败并记录错误,系统不应用该次名单结果```

## openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-fetch-pipeline/spec.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-fetch-pipeline/spec.md
- Lines: 1-15
- SHA256: 989f0d04390b4f15a8c689df470b01dc42abd23641958baab6851fb4c5bc641e

```md
## MODIFIED Requirements

### Requirement: 成功后回传适配层
系统 SHALL 在账号抓取流程完成后,由公共层通过回传适配层向 instar webhook 回调账号级完成状态。回调负载 SHALL 为 `{ starId, token: "instar", status }`。当账号抓取流程成功完成时 `status` SHALL 为 `1`;当账号抓取流程失败结束时 `status` SHALL 为 `0`。该回调语义 SHALL 与具体平台适配器解耦,并 SHALL NOT 改变帖子级去重与成功状态判定。

#### Scenario: 账号成功时回调 status 1
- **WHEN** 某账号抓取流程成功完成
- **THEN** 系统调用回传适配层发送 `{starId, token:"instar", status:1}`

#### Scenario: 账号失败时回调 status 0
- **WHEN** 某账号抓取流程最终失败
- **THEN** 系统调用回传适配层发送 `{starId, token:"instar", status:0}`

#### Scenario: 回调失败不回滚抓取结果
- **WHEN** 回传适配层调用失败
- **THEN** 系统记录错误,但不改变该账号抓取流程已产生的抓取与去重结果```

## openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-fetch-service/spec.md

- Source: openspec/changes/align-tiktok-with-crawler-ins-contract/specs/tiktok-fetch-service/spec.md
- Lines: 1-27
- SHA256: ecd42dd0803959d07b09c723c16966b9df6755062593a7172f5f42eed0497277

```md
## MODIFIED Requirements

### Requirement: 主动抓取账号数量上限
系统 SHALL 支持主动抓取指定账号的帖子。当该账号帖子过多时,系统 SHALL 只处理最近 100 条帖子,并 SHALL 遵守去重规则。服务入口 SHALL 兼容 `accountId` 与 `starId` 两种触发字段,且至少提供其一。系统内部 SHALL 统一使用账号标识入队,并保持异步受理语义。

#### Scenario: 限制最近 100 条
- **WHEN** 主动抓取某账号且其帖子数量超过 100
- **THEN** 系统只处理最近 100 条帖子

#### Scenario: 主动抓取仍去重
- **WHEN** 主动抓取的账号中包含已成功抓取过的帖子
- **THEN** 系统跳过这些帖子,不重复下载或上传

#### Scenario: 主动触发异步受理
- **WHEN** 外部通过 HTTP 主动触发抓取某账号
- **THEN** 系统将该账号入队(置为尽快抓取)并立即返回受理响应,不阻塞等待抓取完成;抓取进度可通过状态查询接口获取

#### Scenario: 主动触发的账号本地不存在
- **WHEN** 主动触发抓取的账号本地尚未存在于账号名单中
- **THEN** 系统即时插入一条 active 账号记录并抓取,不依赖名单对账时机

#### Scenario: 兼容 starId 输入
- **WHEN** 外部通过 HTTP 主动触发时仅提供 `starId`
- **THEN** 系统将其映射为内部账号标识后入队并受理,返回 `202`

#### Scenario: 缺少可用账号标识
- **WHEN** 外部通过 HTTP 主动触发时 `accountId` 与 `starId` 都未提供
- **THEN** 系统返回 `400`,且不入队抓取```

