## ADDED Requirements

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
- **THEN** 本轮对账失败并记录错误,系统不应用该次名单结果