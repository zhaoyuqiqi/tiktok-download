## Why

现有 `src/ytdlp-manager/ytDlpManager.ts` 把「运行时」和「联网更新」两件事耦合在一个 `ensureYtDlp()` 里:项目每次启动都去请求 GitHub,一旦网络不可达就直接退出,无法在已有可用二进制时继续服务。我们改为把版本更新交给系统定时任务,项目运行时只需拿到 `current` 二进制路径,并用一个统一的 `YtDlpService` 作为所有 yt-dlp 调用方的入口。

## What Changes

- **BREAKING** 移除运行时联网逻辑:项目启动不再请求 GitHub、不再在启动路径校验/下载版本。
- 新增导出 `YtDlpService` 类,作为运行时统一入口:解析并确保 `current` 指向的二进制可用,返回其路径;不联网、不检查版本。`current` 缺失时报错(提示先运行更新任务)。
- 所有使用 yt-dlp 的地方(`runner.ts`、`index.ts` 及未来新增处)统一通过 `YtDlpService` 获取二进制路径,不再硬编码 `"yt-dlp"` 或手动拼路径。
- 新增供**系统定时任务(cron)**调用的更新入口:检查 GitHub 最新版 → 下载 → 校验 SHA256 → `chmod +x` → 切换 `current` 软链接 → 仅保留最近两个版本。更新入口**接受 `proxy` 参数**,以便通过代理访问 GitHub 与下载链接。
- 工具目录保持独立于项目(默认 `/opt/yt-dlp`,可通过环境变量覆盖)。
- 扩展 `ProcessRunner`:新增流式执行能力,支持 `yt-dlp -o - <url>` 将下载内容以可读流形式输出(不缓冲为字符串),`proxy` 在流式形式下同样透传。
- **BREAKING** runner 的进程 spawn 后端整体由 `Bun.spawn` 切换到 `node:child_process.spawn`,缓冲与流式共用同一后端(原生 Node 流,便于管道)。

## Capabilities

### New Capabilities
- `ytdlp-version-manager`: 管理独立工具目录下的 yt-dlp 二进制版本。包含两部分职责——运行时的 `YtDlpService`(仅解析/确保 `current` 可用,不联网)与 cron 可调用的更新入口(检查最新版、下载、SHA256 校验、切换 `current`、保留最近两个版本、支持 proxy)。

### Modified Capabilities
- `tiktok-download-scheduler`: yt-dlp 二进制的可用性来源由「PATH 中的全局 yt-dlp」改为「`YtDlpService` 提供的 `current` 托管二进制」;解析与下载阶段的 yt-dlp 调用路径统一从 `YtDlpService` 获取。新增流式下载输出能力(`yt-dlp -o -`),由扩展后的 `ProcessRunner` 提供可读流。

## Impact

- 代码:重写 `src/ytdlp-manager/`(拆分 `YtDlpService` 与更新入口),更新 `src/index.ts` 装配、`src/ytdlp-manager/runner.ts` 的路径获取与 spawn 后端;扩展 `src/types.ts` 的 `ProcessRunner`(新增流式方法);新增 cron 可执行的更新入口文件与测试。
- 行为:项目运行时不再依赖网络;版本更新完全由系统定时任务驱动。
- 外部依赖:无新增第三方依赖;GitHub Release API 与下载链接的访问通过可选 `proxy` 参数支持。
