## 1. 服务骨架与依赖

- [x] 1.1 引入 Elysia、cos-nodejs-sdk-v5 依赖,搭建常驻服务入口(替换 CLI 主入口)
- [x] 1.2 定义服务配置(抓取周期、全局并发、代理、COS、持久化目录)与环境变量约定

## 2. 持久化层(SQLite,最小状态)

- [x] 2.1 设计并建立 SQLite schema:accounts(platform/account_id/next_run_at/last_post_at/last_video_id/active)、fetched_posts(platform/post_id/published_at?/status/attempts/fetched_at);只存调度与去重必需字段,不存帖子全量信息
- [x] 2.2 实现去重查询/写入与账号游标读写,保证重启后状态保留

## 3. 平台适配器抽象

- [x] 3.1 定义平台无关的 PlatformAdapter 接口(listPosts/fetchDetail/cleanse→标准化 Post/openMediaStream)与标准化 Post 结构
- [x] 3.2 实现 TikTokAdapter(基于 yt-dlp):列表 `-J --flat-playlist`、详情 `-J`、清洗、`-o -` 媒体流

## 4. 抓取流水线(公共层)

- [x] 4.1 编排入口 username + lastVideoId → 适配器列表+详情,过滤 lastVideoId 之前的已抓帖子
- [x] 4.2 按发布时间从旧到新排序(平台无关标准化结构)
- [x] 4.3 实现 COS key 纯函数(输入标准化 Post,默认 yyyyMMddHHmmss + 帖子 id)并编写单测
- [x] 4.4 实现公共层将适配器媒体流直传 COS(不落地磁盘)
- [x] 4.5 实现公共层回传 instar-server 的适配层接口与预留实现

## 5. 调度、并发与频率控制(平台无关)

- [x] 5.1 实现全局并发上限(默认 2,可配置)与同账号串行
- [x] 5.2 实现指数退避重试(最多 3 次,1m/3m/10m),退避期间不占并发额度
- [x] 5.3 实现每次适配器抓取调用前 2–8 秒随机延迟(风控由适配器/公共层协作)
- [x] 5.4 实现 due 驱动调度 tick(只挑 next_run_at 到期且 active,LIMIT 为并发剩余额度)+ 外部 HTTP 主动触发旁路共用同一流水线
- [x] 5.5 实现外部账号名单 reconcile(外部 HTTP 拉全量,默认 5min 可配;新增置 next_run_at=now+jitter、已存在不覆盖、移除标记 inactive,不触发抓取)
- [x] 5.6 实现账号活跃度自适应频率(抓完重算 next_run_at:24h 无新帖降到约 6h,高频最小间隔 30min)
- [x] 5.7 实现主动抓取指定账号,帖子过多时仅取最近 100 条且遵守去重

## 6. HTTP 接口

- [x] 6.1 提供主动抓取指定账号的 HTTP 接口(旁路触发)
- [x] 6.2 提供任务/抓取与调度状态查询接口(观测积压、进度与账号 next_run_at)
- [x] 6.3 实现外部账号名单 HTTP 客户端(权威源拉取)与其配置/鉴权

## 7. 收尾

- [x] 7.1 补充测试覆盖去重、排序、退避、并发上限、100 条上限、适配器解耦等关键场景
- [x] 7.2 更新 README/部署说明,明确 Docker 需挂载 SQLite 持久化目录
