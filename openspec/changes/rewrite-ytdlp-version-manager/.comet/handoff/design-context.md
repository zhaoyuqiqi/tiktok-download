# Comet Design Handoff

- Change: rewrite-ytdlp-version-manager
- Phase: design
- Mode: compact
- Context hash: fe86fb93178b1abb30f5848bf686a3b94857bb08ff15d71418c85b8a25696c09

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/rewrite-ytdlp-version-manager/proposal.md

- Source: openspec/changes/rewrite-ytdlp-version-manager/proposal.md
- Lines: 1-27
- SHA256: 5bf00a34157e84beed0f35398b01bcd50bbf831903776e795f519f823822273b

```md
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
```

## openspec/changes/rewrite-ytdlp-version-manager/design.md

- Source: openspec/changes/rewrite-ytdlp-version-manager/design.md
- Lines: 1-76
- SHA256: c72e1f0450d01d395744e04ebd2ebb052d3ae86bd964745beac95550d4cce650

```md
## Context

现有 `src/ytdlp-manager/ytDlpManager.ts` 用单个 `ensureYtDlp()` 把「运行时确保二进制」与「联网检查/下载更新」耦合在一起,项目每次启动都请求 GitHub,网络不可达即退出。用户希望:版本更新由**系统定时任务(cron)**驱动,项目运行时只解析 `current` 二进制路径;并导出一个 `YtDlpService` 类作为所有 yt-dlp 调用方获取路径的统一入口。运行环境为 Bun(见 CLAUDE.md),可用 Bun `fetch` 的 `proxy` 选项。

## Goals / Non-Goals

**Goals:**
- 运行时与更新彻底解耦:`YtDlpService`(运行时,不联网)+ 更新入口(cron,联网)。
- `YtDlpService` 作为唯一路径来源,所有调用方经它获取 `current` 二进制路径。
- 更新入口可被 cron 独立执行,支持 `proxy` 参数访问 GitHub。
- 保留最近两个版本,SHA256 校验,原子切换 `current`。

**Non-Goals:**
- 项目运行时的版本检查/周期性轮询(交给 cron)。
- GitHub token / rate-limit 处理。
- 改动 parser / scheduler / uploader 的核心逻辑(仅调整二进制路径来源)。

## Decisions

### D1: 模块拆分为运行时与更新两条路径
- `ytDlpService.ts` — 导出 `YtDlpService`,只做工具目录/`current` 解析,不 import 任何网络逻辑。
- `updater.ts` — 导出更新函数(如 `updateYtDlp(options)`):fetch release → 比对 → 下载 → SHA256 → chmod → 切换 `current` → 清理旧版本。
- `update.ts` — cron 可执行入口(`bun run src/ytdlp-manager/update.ts [--proxy URL]`),解析参数后调用 `updater`。
- `toolDir.ts`(可选)— 共享的工具目录/`current` 路径解析与版本名解析,供 service 与 updater 复用。
- **理由**:运行时代码不再依赖网络模块,天然避免启动联网失败;职责单一便于测试。备选(保留单一 `ensureYtDlp` 加开关)会继续耦合两种失败模式,被否决。

### D2: YtDlpService 接口
- `new YtDlpService({ toolDir? })`,`toolDir` 默认按平台解析(`/opt/yt-dlp`),可经环境变量覆盖。
- `async getBinaryPath(): Promise<string>` — 解析 `current` 软链接目标,校验存在;缺失/不可解析时抛明确错误(提示先运行更新任务)。异步因需 `fs` 检查软链接与文件存在。
- **理由**:方法级异步、无网络;错误信息引导用户运行 cron 更新。备选同步 API 需 `existsSync`,与其余 async I/O 风格不一致,被否决。

### D3: 调用方统一经 YtDlpService 取路径,再注入 runner
- 装配层(`index.ts`)`await service.getBinaryPath()` 得到路径,注入 `new YtDlpRunner(binPath)`。
- `runner.ts` 继续持有 binPath 字符串,但移除 `"yt-dlp"` 默认值,强制由调用方(经 service)提供。
- **理由**:`YtDlpService` 成为唯一路径来源,runner 保持无状态、易测;避免 runner 直接依赖 service 造成循环/耦合。

### D4: proxy 通过 Bun fetch 传递
- `updater` 接受 `proxy?: string`,对 GitHub API 与下载请求使用 `fetch(url, { proxy })`(Bun 支持)。
- `update.ts` 从命令行 `--proxy` 读取并透传。
- **理由**:与项目 Bun 约定一致,无需引入代理库。

### D5: 复用现有下载/校验/清理算法
- 平台资产名选择、SHA256 校验文件解析、保留最近两版的清理逻辑沿用现有已测行为,仅迁移到 `updater.ts`。
- **理由**:这些逻辑已有测试覆盖且正确,重写聚焦于结构解耦而非算法重造。

### D6: runner spawn 后端整体切换到 node:child_process.spawn
- `runner.ts` 的进程启动由 `Bun.spawn` 整体改为 `node:child_process.spawn`,缓冲执行与流式执行共用同一后端。
- 缓冲执行:收集 stdout/stderr chunk 后在进程 `close`/`exit` 时组装为 `ProcessResult`。
- **理由**:单一 spawn 原语,心智一致;`child_process` 提供原生 Node `Readable`,流式 `-o -` 可直接管道到 HTTP/文件,无需 Web→Node 适配;Bun 完整实现 `node:child_process`,无运行时损失。备选(缓冲用 Bun.spawn、仅流式用 child_process)留下两套机制与一层适配,收益为零,被否决。此项对本项目属 BREAKING(内部实现),外部行为不变。

### D7: ProcessRunner 扩展流式方法
- 在 `src/types.ts` 为 `ProcessRunner` 新增流式方法(如 `runStream(args): ProcessStream`),`ProcessStream` 暴露 `stdout: Readable`、`stderr: Readable`、`exited: Promise<number>`。
- 现有缓冲 `run(args): Promise<ProcessResult>` 签名保持不变,`parse` / `download` 不受影响。
- 流式调用方负责消费/管道流并读取退出码;proxy 由调用方拼入 args(与现有 `run` 的 proxy 处理一致)。
- **理由**:缓冲与流式返回类型不同(字符串 vs 流),必须是两个方法;保持 `run` 不变以零风险复用现有 parse/download 测试。方法名与 `ProcessStream` 具体形态可在 build 阶段微调。

## Risks / Trade-offs

- [运行时若从未运行过 cron,`current` 不存在导致启动失败] → `getBinaryPath()` 抛出可读错误,文档/README 说明需先执行一次更新任务;可在 README 给出 cron 与首次初始化命令。
- [Bun fetch 的 `proxy` 选项行为差异] → 在 updater 测试中通过可注入 `fetchImpl` 验证参数传递,不依赖真实网络。
- [移除运行时联网属 BREAKING] → 影响仅限本项目装配层,更新入口补齐同等能力;迁移由 cron 承接。
- [runner 切 child_process 可能有 spawn 行为/流背压差异] → 缓冲路径由现有 parse/download 测试守护;流式路径新增测试(可注入的 runner 抽象/临时脚本)验证流出内容与退出码,不依赖真实网络。

## Migration Plan

1. 新增 `ytDlpService.ts` / `updater.ts` / `update.ts`(及可选 `toolDir.ts`)与测试。
2. `index.ts` 改为经 `YtDlpService` 取路径,移除 `ensureYtDlp` 启动联网逻辑。
3. `runner.ts` 移除硬编码默认二进制。
4. 删除旧 `ytDlpManager.ts`(其能力已迁移)。
5. README/说明补充:cron 执行 `bun run src/ytdlp-manager/update.ts --proxy ...` 及首次初始化。
- 回滚:恢复 `ytDlpManager.ts` 与 `index.ts` 装配即可,工具目录数据结构不变(仍是 `yt-dlp-<version>` + `current`)。

## Open Questions

- 更新入口失败(网络/校验)对 cron 的退出码约定:非 0 退出即可,是否需要结构化日志留待 build 阶段。
- `toolDir.ts` 是否独立成文件,或内联在 service/updater——由 build 阶段按代码量决定。
```

## openspec/changes/rewrite-ytdlp-version-manager/tasks.md

- Source: openspec/changes/rewrite-ytdlp-version-manager/tasks.md
- Lines: 1-30
- SHA256: 1504ac0aed391a7bd2c4616d594329f074c56c4d36d9062c2d9dce3b8cc0402f

```md
## 1. 工具目录与路径解析

- [ ] 1.1 实现工具目录解析(默认 `/opt/yt-dlp` / Windows `C:\opt\yt-dlp`,环境变量覆盖)与 `current`/版本名解析工具(供 service 与 updater 复用)
- [ ] 1.2 为路径/版本名解析编写单元测试(current 指向解析、环境变量覆盖)

## 2. YtDlpService(运行时)

- [ ] 2.1 编写 `YtDlpService.getBinaryPath()` 测试:current 可用返回路径且不联网;current 缺失抛明确错误
- [ ] 2.2 实现 `YtDlpService` 类(解析 current、校验存在、无网络),导出供调用方使用

## 3. 更新入口(cron / 联网)

- [ ] 3.1 编写 `updater` 测试(注入 `fetchImpl`):已是最新不下载;有新版下载→SHA256→chmod 0755→切换 current;SHA256 失败不切换;proxy 参数透传;仅保留最近两个版本
- [ ] 3.2 实现 `updater.ts`(fetch release、平台资产选择、SHA256 校验、chmod、切换 current、清理旧版本、支持 proxy)
- [ ] 3.3 实现 `update.ts` cron 可执行入口(解析 `--proxy` 并调用 updater,失败非 0 退出)

## 4. Runner 后端切换与流式输出

- [ ] 4.1 在 `src/types.ts` 扩展 `ProcessRunner`:新增流式方法(如 `runStream(args): ProcessStream`),定义 `ProcessStream`(`stdout`/`stderr` 为 Node `Readable`,`exited: Promise<number>`);`run` 缓冲签名保持不变
- [ ] 4.2 编写 runner 测试:缓冲 `run` 行为(切 child_process 后 parse/download 仍通过);流式 `runStream` 输出 `yt-dlp -o -` 内容并可获取退出码;proxy 透传
- [ ] 4.3 重写 `runner.ts`:spawn 后端整体改为 `node:child_process.spawn`,实现缓冲 `run` 与流式 `runStream`;移除硬编码 `"yt-dlp"` 默认值,二进制路径由调用方(经 YtDlpService)提供

## 5. 装配接入 YtDlpService

- [ ] 5.1 更新 `src/index.ts`:移除启动联网的 `ensureYtDlp`,改为经 `YtDlpService.getBinaryPath()` 取路径注入 runner,current 缺失时明确报错退出

## 6. 清理与验证

- [ ] 6.1 删除旧 `ytDlpManager.ts` 及其测试(能力已迁移到 service/updater)
- [ ] 6.2 运行 `bun test` 全量通过;README/说明补充 cron 更新命令与首次初始化步骤
```

## openspec/changes/rewrite-ytdlp-version-manager/specs/tiktok-download-scheduler/spec.md

- Source: openspec/changes/rewrite-ytdlp-version-manager/specs/tiktok-download-scheduler/spec.md
- Lines: 1-37
- SHA256: 6ef9cff57ff73174ef6cb61adb5b0457518e63e448484ff90e2088b7f4172a19

```md
## ADDED Requirements

### Requirement: 流式下载输出
系统 SHALL 支持以 `yt-dlp -o - <url>` 形式将下载内容以可读流的方式输出,调用方 SHALL 能将其作为可读流消费(例如管道到 HTTP 响应或文件),而非缓冲为字符串。系统 SHALL 暴露该进程的标准输出可读流、标准错误可读流与退出码。当指定了代理时,流式下载 SHALL 同样将该代理透传给 yt-dlp 的 `--proxy` 选项。

#### Scenario: 以流的方式输出下载内容
- **WHEN** 调用方以流式方式请求下载某个视频(`yt-dlp -o - <url>`)
- **THEN** 系统返回一个可读流,yt-dlp 的媒体字节从标准输出直接流出供调用方消费,且退出码可在进程结束后获取

#### Scenario: 流式下载透传代理
- **WHEN** 调用方以流式方式请求下载并指定了 `--proxy http://127.0.0.1:7890`
- **THEN** 系统在启动 yt-dlp 流式下载进程时带上 `--proxy http://127.0.0.1:7890`

#### Scenario: 流式进程失败时暴露退出码
- **WHEN** 流式下载的 yt-dlp 进程以非 0 状态码退出(如下载中途失败)
- **THEN** 系统暴露的退出码反映该非 0 值,供调用方判断输出可能被截断并据此处理(如删除/重传已上传的对象);系统本身不对截断做兜底

## MODIFIED Requirements

### Requirement: 解析视频列表
系统 SHALL 使用 `yt-dlp -J` 解析输入 URL,并自动识别单视频与用户主页两种来源,产出一个或多个待下载视频条目。当来源为用户主页(包含多个条目)且指定了 `--limit N` 时,系统 SHALL 只取最新的 N 个条目;`--limit` 对单视频来源 SHALL 不生效。系统所使用的 yt-dlp 二进制 SHALL 由 `YtDlpService` 提供的 `current` 托管二进制获取,而非依赖 PATH 中的全局 yt-dlp。

#### Scenario: 解析单个视频
- **WHEN** 用户执行 `download <single-video-url>`
- **THEN** 系统通过 `yt-dlp -J` 解析得到 1 个视频条目,并据此创建 1 个下载任务

#### Scenario: 解析用户主页并限制数量
- **WHEN** 用户执行 `download <user-url> --limit 5`
- **THEN** 系统解析出该用户最新的 5 个视频条目,并创建 5 个下载任务

#### Scenario: 解析用户主页未指定数量
- **WHEN** 用户执行 `download <user-url>` 且未指定 `--limit`
- **THEN** 系统解析出该用户主页下的全部视频条目,并为每个条目创建一个下载任务

#### Scenario: yt-dlp 二进制不可用
- **WHEN** `YtDlpService` 无法解析出可用的 `current` 托管二进制(例如工具目录缺失 `current`)
- **THEN** 系统 SHALL 输出明确的错误信息并以非 0 状态码退出,不创建任何任务
```

## openspec/changes/rewrite-ytdlp-version-manager/specs/ytdlp-version-manager/spec.md

- Source: openspec/changes/rewrite-ytdlp-version-manager/specs/ytdlp-version-manager/spec.md
- Lines: 1-53
- SHA256: 25c4123be3d29d4a6fa6bda861d3918af73308ee4098448b4752995815740225

```md
## ADDED Requirements

### Requirement: 独立工具目录与 current 软链接
系统 SHALL 在独立于项目源码的工具目录(默认 `/opt/yt-dlp`,Windows 默认 `C:\opt\yt-dlp`,可通过环境变量覆盖)中维护 yt-dlp 二进制。每个版本 SHALL 以 `yt-dlp-<version>` 命名独立保存,`current` SHALL 为指向某个具体版本二进制的软链接。系统 SHALL NOT 使用 PATH 中的全局 yt-dlp,也 SHALL NOT 将二进制存放在项目目录内。

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
```

