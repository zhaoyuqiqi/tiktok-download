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
- `new YtDlpService({ toolDir? })`,`toolDir` 默认按平台解析为当前用户可写目录(macOS: `~/Library/Application Support/tiktok-downloader/yt-dlp`; Linux: `~/.local/share/tiktok-downloader/yt-dlp`; Windows: `%LOCALAPPDATA%\\tiktok-downloader\\yt-dlp`),并可经环境变量覆盖。
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
