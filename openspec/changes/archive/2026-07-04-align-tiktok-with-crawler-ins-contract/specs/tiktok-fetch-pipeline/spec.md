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
- **THEN** 系统记录错误,但不改变该账号抓取流程已产生的抓取与去重结果