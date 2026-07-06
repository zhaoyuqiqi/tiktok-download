# tiktok-downloader

基于 [Bun](https://bun.com) + [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的 **TikTok 抓取常驻服务**。

当前形态为服务化 Worker：
- 定时扫描到期账号并抓取
- 支持 HTTP 主动触发单账号抓取
- SQLite 持久化调度状态与去重状态（重启可恢复）
- 支持外部账号名单定时全量对账（reconcile）

## 前置依赖

- [Bun](https://bun.com) >= 1.2

安装依赖：

```bash
bun install
```

## yt-dlp 二进制管理

yt-dlp 二进制由独立工具目录托管（默认用户可写目录）：
- macOS: `~/Library/Application Support/tiktok-downloader/yt-dlp`
- Linux: `~/.local/share/tiktok-downloader/yt-dlp`
- Windows: `%LOCALAPPDATA%\tiktok-downloader\yt-dlp`

可通过 `YT_DLP_TOOL_DIR` 覆盖。

### 初始化 / 更新

首次运行前先下载并切换 `current`：

```bash
bun run src/ytdlp-manager/update.ts
```

代理下载示例：

```bash
bun run src/ytdlp-manager/update.ts --proxy http://127.0.0.1:7890
```

## 启动服务

```bash
bun run src/index.ts
```

默认监听：`HOST=0.0.0.0`，`PORT=3000`。

## 完整跑起来前你需要准备什么

最少需要准备这 4 类信息：

- 抓取侧：是否需要代理（可选，`APP_PROXY_URL`）
- 存储侧：COS 凭据（`COS_BUCKET/COS_REGION/COS_SECRET_ID/COS_SECRET_KEY`，必填）
- 回传侧：`instar-server` 接口地址（至少 `APP_INSTAR_POST_WEBHOOK_URL` 必填）
- 账号源（可选）：`APP_ACCOUNT_SOURCE_URL` 与其 Bearer

如果你只想先验证“服务能跑 + 手动抓取 + 回传”，建议先配置：

```bash
# 必填：帖子回传（server）
APP_INSTAR_POST_WEBHOOK_URL=http://<host>:<port>/post/api/sync

# 建议补齐：明星资料同步 + 存在性查询（可显式给，也可走自动推导）
APP_INSTAR_STAR_SYNC_URL=http://<host>:<port>/star/api/sync
APP_INSTAR_STAR_EXISTS_URL=http://<host>:<port>/star/api/crawler/exists

# 必填：COS
COS_BUCKET=...
COS_REGION=...
COS_SECRET_ID=...
COS_SECRET_KEY=...
```

## 核心环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `PORT` | `3000` | HTTP 监听端口 |
| `APP_FETCH_INTERVAL_SECONDS` | `300` | due 调度 tick 周期（秒） |
| `APP_ACCOUNT_RECONCILE_INTERVAL_SECONDS` | `300` | 外部名单对账周期（秒） |
| `APP_GLOBAL_CONCURRENCY` | `2` | 全局并发上限 |
| `APP_PROXY_URL` | 空 | 抓取时透传给 `yt-dlp --proxy` |
| `APP_DEBUG` | `0` | `1/true/on` 时开启结构化阶段日志；默认关闭 |
| `APP_DATA_DIR` | `./data` | 持久化目录，SQLite 位于 `state.db` |
| `APP_ACCOUNT_SOURCE_URL` | 空 | 外部账号名单源 URL（配置后才会启用 reconcile 拉取） |
| `APP_ACCOUNT_SOURCE_AUTH_BEARER` | 空 | 外部名单 Bearer Token |
| `APP_INSTAR_WEBHOOK_URL` | 空 | 账号抓取完成回调地址（可选，不配置则跳过账号级完成回调） |
| `APP_INSTAR_WEBHOOK_AUTH_BEARER` | 空 | 账号完成回调 Bearer Token |
| `APP_INSTAR_POST_WEBHOOK_URL` | 空 | **必填**：帖子抓取成功后逐条同步回调地址（缺失则服务启动报错） |
| `APP_INSTAR_POST_WEBHOOK_AUTH_BEARER` | 空 | 帖子逐条回调 Bearer Token |
| `APP_INSTAR_STAR_SYNC_URL` | 空 | 明星资料同步地址（可选）；为空时会尝试由 `APP_INSTAR_POST_WEBHOOK_URL` 自动推导为同域 `/star/api/sync` |
| `APP_INSTAR_STAR_SYNC_AUTH_BEARER` | 空 | 明星资料同步 / 存在性查询共用 Bearer Token |
| `APP_INSTAR_STAR_EXISTS_URL` | 空 | 明星存在性查询地址（可选）；为空时且 `APP_INSTAR_STAR_SYNC_URL` 以 `/sync` 结尾时，自动推导为同路径 `/crawler/exists` |
| `COS_BUCKET` | 空 | COS bucket（必填；缺失会导致服务启动报错） |
| `COS_REGION` | 空 | COS region（必填；缺失会导致服务启动报错） |
| `COS_SECRET_ID` | 空 | COS secret id（必填；缺失会导致服务启动报错） |
| `COS_SECRET_KEY` | 空 | COS secret key（必填；缺失会导致服务启动报错） |
| `COS_KEY_PREFIX` | `tiktok-download` | COS key 前缀 |

> 帖子级回调说明：同步 payload 严格遵循 `crawler-ins` 的 `Post` 契约（`insPostId/starName/fullName/title/isTop/insStarId/publishTime/resources`），且**不再传 `cosKey`**；上传到 COS 后，会将 COS 资源地址写入 `resources[].url`。

开启 debug 日志示例：

```bash
APP_DEBUG=1 bun run src/index.ts
```

关闭 debug（默认）时不输出这些阶段日志。

## HTTP 接口

### `GET /health`

健康检查。

### `POST /fetch`

主动触发账号抓取（旁路入队，复用同一调度流水线）。

请求体（`accountId` 与 `starId` 二选一，若同时存在优先 `accountId`）：

```json
{
  "starId": "@alice",
  "limit": 3,
  "categoryId": 7
}
```

字段说明：
- `limit`：可选，`1~100` 的整数，仅影响本次手动抓取条数。
- `categoryId`：可选，大于等于 `-1` 的整数，仅用于手动触发时透传到明星资料同步。

响应（`202 Accepted`）：

```json
{
  "accepted": true,
  "accountId": "@alice",
  "starId": "@alice",
  "source": "manual",
  "limit": 3,
  "categoryId": 7
}
```

示例：

```bash
curl -X POST http://127.0.0.1:3000/fetch \
  -H 'content-type: application/json' \
  -d '{"starId":"@alice","limit":3,"categoryId":7}'
```

> 自动 `tick` 的 due 抓取不会携带 `categoryId`；仅手动 `POST /fetch` 触发时会传该参数。

### `GET /status`

返回调度与抓取状态摘要：
- 当前运行中的账号数
- 账号总数 / active / inactive / due
- 账号列表（含 `nextRunAt`）
- 去重表累计抓取记录数

## instar 对接契约

### 回传到 instar-server：地址怎么传、该传什么

推荐显式配置这 2 个地址：

- `APP_INSTAR_POST_WEBHOOK_URL` → `POST /post/api/sync`（**必填**）
- `APP_INSTAR_STAR_SYNC_URL` → `POST /star/api/sync`（可选，建议配置）

如果你不想显式配置 `APP_INSTAR_STAR_SYNC_URL`，也可以只给 `APP_INSTAR_POST_WEBHOOK_URL`，程序会自动推导：

1. `APP_INSTAR_STAR_SYNC_URL` 为空时：取 `APP_INSTAR_POST_WEBHOOK_URL` 的同域地址并替换路径为 `/star/api/sync`

例如：

- 已配置 `APP_INSTAR_POST_WEBHOOK_URL=http://127.0.0.1:3000/post/api/sync`
- 则默认推导：
  - `APP_INSTAR_STAR_SYNC_URL=http://127.0.0.1:3000/star/api/sync`

Bearer 传参方式：

- 帖子回传 Bearer：`APP_INSTAR_POST_WEBHOOK_AUTH_BEARER`
- 明星资料同步 Bearer：`APP_INSTAR_STAR_SYNC_AUTH_BEARER`
- 账号完成回调 Bearer：`APP_INSTAR_WEBHOOK_AUTH_BEARER`

> 说明：当前 `server` 的 `post/api/sync`、`star/api/sync`、`star/api/crawler/exists` 路由默认未强制 JWT 中间件，但 downloader 仍支持带 Bearer，便于网关层鉴权。

### 账号列表接口（tiktok 定时拉取）

当前仅支持 instar 风格：

```json
{
  "code": 0,
  "data": {
    "list": [
      { "starId": "@alice" },
      { "starId": "@bob" }
    ]
  }
}
```

### 账号完成回调（tiktok -> instar）

当单个账号任务结束时（成功或失败）回调一次：

```json
{
  "starId": "@alice",
  "token": "instar",
  "status": 1
}
```

- `status=1` 表示本次账号任务成功结束
- `status=0` 表示本次账号任务失败结束
- 当前版本回调失败**不重试**，仅记录日志

## Docker 部署（重要）

### 构建镜像

镜像内置 `python3` + `ffmpeg`，并预装 `curl-cffi`（TikTok 抓取常用依赖），可直接运行 `yt-dlp` 入口文件。

```bash
docker build -t tiktok-downloader:latest .
```

### 运行容器

**必须挂载 `APP_DATA_DIR` 对应目录**，否则容器重建会丢失 SQLite 状态，导致去重与调度游标失效。

```bash
docker run --rm -p 3000:3000 \
  -e PORT=3000 \
  -e TZ=Asia/Shanghai \
  -e APP_DATA_DIR=/app/data \
  -e APP_INSTAR_POST_WEBHOOK_URL=http://<host>:<port>/post/api/sync \
  -e COS_BUCKET=... \
  -e COS_REGION=... \
  -e COS_SECRET_ID=... \
  -e COS_SECRET_KEY=... \
  -v $(pwd)/data:/app/data \
  tiktok-downloader:latest
```

如果你把 `APP_DATA_DIR` 改为其它路径，也要同步挂载那个路径。

### 容器内 `yt-dlp` 自动更新（每天凌晨 3 点）

镜像内置 cron，默认会：

- 容器启动时先执行一次 `yt-dlp` 更新检查
- 每天凌晨 `03:00` 再执行一次更新检查（按容器时区 `TZ`）

可选控制项：

- `TZ`：时区，默认 `Asia/Shanghai`
- `DISABLE_YTDLP_BOOTSTRAP=1`：禁用“容器启动即检查一次”
- `APP_PROXY_URL`：若配置，定时更新和启动时更新都会自动带 `--proxy`

## GitHub Actions 构建镜像（GHCR）

仓库已提供 `.github/workflows/docker-image.yml`：

- `pull_request`：仅构建镜像，验证 Dockerfile 可用
- `push main` / `tag v*`：构建并推送到 GHCR

镜像地址规则：`ghcr.io/<owner>/<repo>`（例如 `ghcr.io/your-org/tiktok-downloader`）。

## 测试

```bash
bun test
bunx tsc --noEmit
```
