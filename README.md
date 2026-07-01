# tiktok-downloader

基于 [Bun](https://bun.com) + [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的 TikTok 视频下载任务调度器。支持下载单个视频或某用户最新的 N 个视频,通过固定数量的 Worker 控制并发,下载失败自动重试,下载成功后触发上传 hook(可对接对象存储)。

## 前置依赖

- [Bun](https://bun.com) ≥ 1.2

安装项目依赖:

```bash
bun install
```

## yt-dlp 版本管理

yt-dlp 二进制由独立工具目录托管(默认 `/opt/yt-dlp`, Windows 默认 `C:\opt\yt-dlp`; 可用环境变量 `YT_DLP_TOOL_DIR` 覆盖)。运行时通过 `YtDlpService` 解析 `current` 软链接获取二进制路径, 不联网。

### 首次初始化 / 手动更新

首次使用需先运行一次更新任务下载二进制并建立 `current` 软链接:

```bash
bun run src/ytdlp-manager/update.ts
```

如需经代理访问 GitHub:

```bash
bun run src/ytdlp-manager/update.ts --proxy http://127.0.0.1:7890
```

### 定时更新(cron)

把上面的命令加入系统 crontab, 例如每天 03:17 更新一次:

```bash
17 3 * * * cd /path/to/tiktok-downloader && bun run src/ytdlp-manager/update.ts >> /var/log/yt-dlp-update.log 2>&1
```

更新成功切换 `current` 后仅保留最近两个版本; SHA256 校验失败或网络失败时不切换 `current` 并以非 0 状态码退出。

## 快速开始

```bash
# 先初始化 yt-dlp 二进制
bun run src/ytdlp-manager/update.ts

# 下载单个视频(输出到 ./output)
bun run src/index.ts "https://www.tiktok.com/@user/video/1234567890"

# 下载某用户最新 5 个视频,2 个并发
bun run src/index.ts "https://www.tiktok.com/@user" --limit 5 --workers 2
```

## 命令格式

```
bun run src/index.ts <url> [--limit N] [--workers N] [--retry N] [-o DIR] [--proxy URL]
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `<url>` | (必填) | TikTok 单视频或用户主页 URL。程序自动识别单视频 / 用户列表 |
| `--limit N` | 无 | 仅对用户主页生效:只下载最新 N 个视频。单视频时忽略 |
| `--workers N` | `2` | 并发 Worker 数,即任意时刻最多同时运行的 yt-dlp 进程数 |
| `--retry N` | `2` | 单个视频下载失败的重试次数(固定 2s 延迟退避),耗尽后标记失败 |
| `-o`, `--output DIR` | `./output` | 下载输出目录,文件名使用 yt-dlp 默认模板 |
| `--proxy URL` | 无 | 代理地址,透传给 yt-dlp 的 `--proxy`,解析与下载两阶段都生效 |

## 使用示例

```bash
# 单视频
bun run src/index.ts "https://www.tiktok.com/@dewy7788/video/7650837890976501008"

# 用户最新 10 个视频,4 并发,失败重试 3 次
bun run src/index.ts "https://www.tiktok.com/@user" --limit 10 --workers 4 --retry 3

# 指定输出目录
bun run src/index.ts "https://www.tiktok.com/@user/video/123" -o ./downloads

# 通过代理(国内访问 TikTok 通常需要)
bun run src/index.ts "https://www.tiktok.com/@user/video/123" --proxy http://127.0.0.1:7890
```

> 代理也可用环境变量:`HTTPS_PROXY=http://127.0.0.1:7890 bun run src/index.ts <url>`(yt-dlp 子进程会继承环境变量)。`--proxy` 优先级更明确,推荐使用。

## 输出与退出码

运行结束打印汇总:

```
成功 8 / 失败 2 / 共 10
```

退出码:全部成功为 `0`;有任意视频失败、URL 缺失或 `yt-dlp current` 不可用时为 `1`。

下载文件落在输出目录(默认 `./output/`,已加入 `.gitignore`),文件名为 yt-dlp 默认模板(形如 `<title> [<id>].mp4`)。

## 项目结构

```
src/
  index.ts          # CLI 入口:参数解析、组装、汇总
  types.ts          # 共享类型
  parsing/          # 解析:yt-dlp -J 识别单/多视频
  scheduling/       # 任务模型 TaskQueue + 并发调度 scheduler
  execution/        # 下载执行: runner(调用 current) + worker(下载单个视频)
  ytdlp-manager/    # yt-dlp 版本管理: toolDir/service/updater/update CLI
  upload/           # Uploader 接口 + NoopUploader 桩(可替换为对象存储)
```

## 上传 hook

每个视频下载成功后会异步调用 `Uploader.upload(filePath)`(不阻塞下载、上传失败不影响下载状态)。默认使用 `NoopUploader`(空实现)。如需上传到对象存储,实现 `src/upload/uploader.ts` 中的 `Uploader` 接口并在 `src/index.ts` 中替换 `new NoopUploader()` 即可。

## 测试

```bash
bun test src/ytdlp-manager/ # 运行 yt-dlp 版本管理模块测试
bun test                    # 运行全部单元测试
bunx tsc --noEmit           # 类型检查
```
