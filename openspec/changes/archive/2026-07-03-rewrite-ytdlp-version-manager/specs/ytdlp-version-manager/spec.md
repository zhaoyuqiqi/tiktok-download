## ADDED Requirements

### Requirement: 独立工具目录与 current 软链接
系统 SHALL 在独立于项目源码的工具目录中维护 yt-dlp 二进制。默认路径 SHALL 使用当前用户可写目录：macOS 为 `~/Library/Application Support/tiktok-downloader/yt-dlp`，Linux 为 `~/.local/share/tiktok-downloader/yt-dlp`，Windows 为 `%LOCALAPPDATA%\\tiktok-downloader\\yt-dlp`；仍可通过环境变量覆盖。 每个版本 SHALL 以 `yt-dlp-<version>` 命名独立保存,`current` SHALL 为指向某个具体版本二进制的软链接。系统 SHALL NOT 使用 PATH 中的全局 yt-dlp,也 SHALL NOT 将二进制存放在项目目录内。

#### Scenario: current 指向具体版本
- **WHEN** 工具目录中存在 `yt-dlp-2026.06.28` 且 `current` 软链接指向它
- **THEN** 通过 `current` 解析到的目标为 `yt-dlp-2026.06.28`

#### Scenario: 工具目录可通过环境变量覆盖
- **WHEN** 设置了工具目录环境变量为自定义路径
- **THEN** 系统在该自定义路径下维护版本二进制与 `current` 软链接,而非默认 `/opt/yt-dlp`

### Requirement: 运行时 YtDlpService 解析二进制路径
系统 SHALL 导出 `YtDlpService` 类作为运行时获取 yt-dlp 二进制的统一入口。`YtDlpService` SHALL 提供解析 `current` 指向的二进制路径的方法。运行时路径解析 SHALL NOT 访问网络、SHALL NOT 检查或更新版本。所有使用 yt-dlp 的调用方 SHALL 通过 `YtDlpService` 获取二进制路径,而非硬编码 `"yt-dlp"` 或自行拼接路径。当 `current` 缺失或不可解析时,`YtDlpService` SHALL 抛出明确错误,提示先运行更新任务。

#### Scenario: current 可用时返回二进制路径
- **WHEN** 工具目录中 `current` 指向一个存在的版本二进制,调用方向 `YtDlpService` 请求二进制路径
- **THEN** `YtDlpService` 返回该 `current` 二进制的路径,且不发起任何网络请求

#### Scenario: current 缺失时报错
- **WHEN** 工具目录中不存在 `current`(或其目标不存在),调用方向 `YtDlpService` 请求二进制路径
- **THEN** `YtDlpService` 抛出明确错误,提示需要先运行更新任务,且不发起网络请求

#### Scenario: 调用方统一经由 YtDlpService 取路径
- **WHEN** 需要执行 yt-dlp 的组件(如下载/解析的进程调用方)需要二进制路径
- **THEN** 它从 `YtDlpService` 获取路径,而不使用 PATH 中的全局 yt-dlp 或硬编码路径

### Requirement: 供定时任务调用的版本更新入口
系统 SHALL 提供一个可被系统定时任务(cron)调用的更新入口,用于将工具目录中的 yt-dlp 升级到 GitHub 最新版。更新入口 SHALL 依次:通过 `https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest` 获取最新版本信息 → 若本地 `current` 已是最新则不下载 → 否则下载对应平台二进制与官方 SHA256 校验文件 → 校验 SHA256 → `chmod +x`(0755)→ 将 `current` 软链接切换到新版本。更新入口 SHALL 接受可选的 `proxy` 参数,并在访问 GitHub API 与下载链接时使用该代理。更新入口 SHALL 可作为独立可执行入口被外部调度器调用。

#### Scenario: 已是最新版本时不下载
- **WHEN** 更新任务运行,GitHub 最新版本与本地 `current` 版本相同且该二进制存在
- **THEN** 系统不下载任何文件,`current` 保持不变

#### Scenario: current 缺失但最新版二进制已存在时自愈
- **WHEN** 工具目录中已存在与 GitHub 最新版本匹配的版本二进制,但 `current` 软链接缺失
- **THEN** 系统不重新下载二进制,而是重建 `current` 指向该现有版本二进制,并继续复用现有版本

#### Scenario: 有新版本时下载并切换
- **WHEN** 更新任务运行,GitHub 最新版本高于/不同于本地 `current` 版本
- **THEN** 系统下载新版本二进制,SHA256 校验通过后 `chmod` 为 0755,并将 `current` 切换指向新版本二进制

#### Scenario: SHA256 校验失败时不切换
- **WHEN** 更新任务下载的二进制 SHA256 与官方校验文件不一致
- **THEN** 系统报错退出,不切换 `current`,保留原有 `current` 指向

#### Scenario: 通过 proxy 访问 GitHub
- **WHEN** 更新任务以 `proxy` 参数运行
- **THEN** 系统在请求 GitHub Release API 与下载二进制/校验文件时均经由该代理

### Requirement: 仅保留最近两个版本
系统在更新任务成功切换 `current` 后 SHALL 仅保留最近的两个版本二进制(含新切换的 `current` 指向的版本),更早的版本 SHALL 被删除。系统 SHALL NOT 删除 `current` 当前指向的版本。

#### Scenario: 升级后清理旧版本
- **WHEN** 工具目录中已有 `yt-dlp-2026.06.10`、`yt-dlp-2026.06.20`,更新任务成功下载并切换到 `yt-dlp-2026.06.28`
- **THEN** 工具目录仅保留 `yt-dlp-2026.06.20` 与 `yt-dlp-2026.06.28`,`yt-dlp-2026.06.10` 被删除
