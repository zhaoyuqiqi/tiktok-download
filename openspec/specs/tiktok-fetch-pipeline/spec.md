# tiktok-fetch-pipeline Specification

## Purpose
TBD - created by archiving change serve-tiktok-download-worker. Update Purpose after archive.
## Requirements
### Requirement: 平台适配器抽象
系统 SHALL 通过平台无关的适配器接口(`PlatformAdapter`)进行抓取,使调度与公共处理逻辑与具体平台解耦。适配器 SHALL 负责:列出账号帖子(`listPosts`)、抓取帖子详情(`fetchDetail`)、清洗详情为平台无关的标准化帖子结构(`cleanse`)、打开帖子媒体流(`openMediaStream`)。调度、并发控制、退避重试、去重、COS 上传与回传等公共逻辑 SHALL NOT 依赖任何具体平台细节,仅依赖该接口与标准化结构。TikTok 适配器 SHALL 基于 yt-dlp 实现。新增其他平台 SHALL 只需实现一个新适配器,不改动调度与公共逻辑。

#### Scenario: 调度器不依赖具体平台
- **WHEN** 调度器发起一次抓取
- **THEN** 调度器只通过 `PlatformAdapter` 接口与标准化帖子结构交互,不直接调用平台特有命令(如 yt-dlp)

#### Scenario: 新增平台只加适配器
- **WHEN** 需要接入一个新平台
- **THEN** 只需实现一个新的 `PlatformAdapter` 并注册,调度、持久化、并发、退避、去重逻辑无需修改

### Requirement: 列表与详情两段抓取
系统 SHALL 以 `username` 与 `lastVideoId` 作为抓取入口:适配器先抓取该账号的帖子列表(TikTok 适配器通过 `yt-dlp -J --flat-playlist`),再对候选帖子逐条抓取详情(TikTok 适配器通过 `yt-dlp -J`)。系统 SHALL 仅抓取 `lastVideoId` 之后的新帖子;当 `lastVideoId` 为空时按抓取策略处理全部候选。

#### Scenario: 先列表后详情
- **WHEN** 传入 `username` 与 `lastVideoId`
- **THEN** 适配器先得到帖子列表,再对每个候选帖子抓取详情

#### Scenario: 仅抓取新帖子
- **WHEN** 列表中包含 `lastVideoId` 及其之前已抓过的帖子
- **THEN** 系统只处理 `lastVideoId` 之后的新帖子,不重复处理已抓过的帖子

### Requirement: 按发布时间从远及近抓取
系统 SHALL 从详情中提取帖子发布时间,并按发布时间从旧到新的顺序处理与展示帖子,SHALL NOT 使用抓取入库时间作为排序依据。

#### Scenario: 发布时间升序处理
- **WHEN** 一批新帖子发布时间各不相同
- **THEN** 系统按发布时间从旧到新依次抓取处理,展示顺序与发布时间一致

#### Scenario: 发布时间缺失时估算并标记
- **WHEN** 某帖子详情中没有可用的发布时间字段
- **THEN** 系统仍抓取该帖子,按列表倒序位置估算其发布时间并标记为估算(不精确),不因缺时间丢弃该帖

### Requirement: 数据清洗
适配器 SHALL 在抓取到帖子详情后将其清洗为平台无关的标准化帖子结构,供公共层的上传与回传使用。标准化结构 SHALL 是平台无关的,公共处理逻辑 SHALL NOT 依赖平台特有字段。

#### Scenario: 清洗详情
- **WHEN** 适配器抓取到一条帖子的原始详情
- **THEN** 适配器清洗出平台无关的标准化帖子结构,供后续公共层 COS 上传与回传使用

### Requirement: 视频流直传 COS
系统 SHALL 由适配器打开帖子媒体流(TikTok 适配器通过 `yt-dlp -o -`),再由公共层将该流直接上传到 COS 对象存储,SHALL NOT 依赖先落地到本地磁盘再上传。COS 对象的 key SHALL 由一个纯函数生成:输入为标准化帖子结构,输出为字符串;默认实现返回 `当前时间 yyyyMMddHHmmss` 拼接当前帖子 id。COS 上传逻辑 SHALL 位于公共层,与具体平台适配器解耦。

#### Scenario: 流式上传
- **WHEN** 一条帖子进入下载阶段
- **THEN** 适配器打开视频流,公共层将其直传 COS,不落地本地磁盘

#### Scenario: 单帖抓取上传超时中止
- **WHEN** 一条帖子从打开媒体流到 COS 上传完成超过配置的单帖超时
- **THEN** 系统强制中止下载子进程与 COS 上传,判该帖失败并进入退避重试,不使任务永久卡住

#### Scenario: 默认 COS key 命名
- **WHEN** 使用默认 COS key 纯函数,输入某标准化帖子结构(id 为 `X`)
- **THEN** 函数返回形如 `yyyyMMddHHmmssX` 的字符串

### Requirement: 失败重试与指数退避
系统 SHALL 在单帖子抓取或上传失败时进行重试,最多重试 3 次,重试间隔按指数退避为 1 分钟、3 分钟、10 分钟。超过 3 次仍失败的帖子 SHALL 标记为最终失败,SHALL NOT 影响其他帖子的处理。退避等待期间该任务 SHALL NOT 占用并发额度。

#### Scenario: 退避后成功
- **WHEN** 某帖子首次失败,在退避重试(1m/3m/10m 之一)后成功
- **THEN** 该帖子最终标记为成功

#### Scenario: 重试耗尽仍失败
- **WHEN** 某帖子在 3 次重试后仍失败
- **THEN** 该帖子标记为最终失败,其余帖子不受影响

### Requirement: 成功后回传适配层
系统 SHALL 在帖子抓取并上传成功后,由公共层通过回传适配层输出平台无关的标准化数据用于 instar-server 落库。回传适配层 SHALL 以抽象接口定义,默认提供预留实现;真实 instar-server 接口本次不锁定。回传逻辑 SHALL 与具体平台适配器解耦。回传失败 SHALL NOT 改变帖子已成功抓取的状态。

#### Scenario: 成功触发回传
- **WHEN** 一条帖子抓取并上传成功
- **THEN** 系统调用回传适配层输出该帖子的标准化数据

#### Scenario: 回传失败不回滚成功状态
- **WHEN** 回传适配层调用失败
- **THEN** 系统记录错误,但该帖子仍视为已成功抓取,不重复抓取

