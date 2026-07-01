---
comet_change: rewrite-ytdlp-version-manager
role: technical-design
canonical_spec: openspec
---

# Rewrite yt-dlp Version Manager — Technical Design

## Context

现有 `src/ytdlp-manager/ytDlpManager.ts` 把「运行时确保二进制」与「联网检查/下载更新」耦合在单个 `ensureYtDlp()`,项目每次启动都请求 GitHub,网络不可达即退出。目标:版本更新交给系统定时任务(cron),项目运行时只解析 `current` 二进制路径;导出 `YtDlpService` 作为运行时统一入口;同时把 runner 的 spawn 后端整体切到 `node:child_process.spawn`,并新增流式 `runStream` 以支持 `yt-dlp -o -` 边下边传(典型场景:管道到腾讯云 COS `putObject` 的 `Body`)。

运行环境为 Bun(见 CLAUDE.md),Bun 完整实现 `node:child_process`。

## Goals / Non-Goals

**Goals:**
- 运行时与更新彻底解耦:`YtDlpService`(不联网)+ `updateYtDlp`(cron,联网,支持 proxy)。
- `YtDlpService` 作为运行时唯一路径来源。
- runner 单一 spawn 后端(`child_process`),同时提供缓冲 `run` 与流式 `runStream`。
- 保留最近两个版本、SHA256 校验、原子切换 `current`。

**Non-Goals:**
- 运行时版本检查/周期性轮询(交给 cron)。
- GitHub token / rate-limit 处理。
- **调用方装配(`index.ts` 等)的重构** —— 由用户后续自行完成;本 change 不保留向后兼容。
- parser / scheduler / uploader 的核心逻辑改动。

## Module Structure

```
src/ytdlp-manager/
  toolDir.ts       纯函数底座(无依赖),service 与 updater 共用
  ytDlpService.ts  YtDlpService 类(运行时,不联网)
  updater.ts       updateYtDlp(opts)(cron,联网)
  update.ts        cron 可执行入口(解析 --proxy → updateYtDlp)
  runner.ts        YtDlpRunner(child_process.spawn:run + runStream)
```

`ytDlpService`(不联网)与 `updater`(联网)互不依赖,仅共用 `toolDir` 纯函数,保证运行时代码不牵连网络模块。

## Interfaces

```ts
// src/types.ts —— 扩展 ProcessRunner
import type { Readable } from "node:stream";

interface ProcessStream {
  stdout: Readable;          // yt-dlp -o - 的媒体字节
  stderr: Readable;
  exited: Promise<number>;   // 进程退出码
}

interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;   // 缓冲,签名不变
  runStream(args: string[]): ProcessStream;       // 新增:同步返回(进程已 spawn)
}
```

```ts
// toolDir.ts
function resolveToolDir(rawToolDir?: string): string;   // 默认 /opt/yt-dlp;Win C:\opt\yt-dlp;env(YT_DLP_TOOL_DIR)覆盖
function currentLinkPath(toolDir: string): string;       // <toolDir>/current
function parseVersionFromTarget(target: string): string | undefined;  // yt-dlp-<ver> → <ver>
function versionBinName(version: string): string;        // <ver> → yt-dlp-<ver>
```

```ts
// ytDlpService.ts
class YtDlpService {
  constructor(opts?: { toolDir?: string });
  getBinaryPath(): Promise<string>;   // 解析 current → 校验目标存在 → 返回路径;缺失/不可解析抛明确错误
}
```

```ts
// updater.ts
interface UpdateOptions {
  toolDir?: string;
  proxy?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;   // 注入以便测试,默认 globalThis.fetch
}
interface UpdateResult { updated: boolean; latestVersion: string; localVersion?: string; }
function updateYtDlp(opts?: UpdateOptions): Promise<UpdateResult>;
```

```ts
// update.ts —— cron 入口
// 用法: bun run src/ytdlp-manager/update.ts [--proxy http://...]
// 成功 exit 0;任何失败 console.error + exit(1)
```

## Data Flow

**运行时(不联网):**
```
new YtDlpService({toolDir?}).getBinaryPath()
  → readlink(current) → 校验目标文件存在 → 返回绝对路径
  → current 缺失/目标不存在 → throw(提示先运行更新任务)
```

**cron 更新(联网,支持 proxy):**
```
bun run update.ts --proxy X
  → updateYtDlp({proxy})
  → fetch(releases/latest, {proxy})  取 tag_name + assets
  → readCurrentVersion(toolDir)
  → tag 相等且二进制存在 → updated:false 返回(不下载)
  → 否则: 选平台资产 + 找 SHA2-256SUMS 资产
         → fetch(二进制, {proxy}) + fetch(sums, {proxy})
         → sha256(二进制) 与 sums 中对应条目比对
         → 不符 → throw(不切 current)
         → 符合 → writeFile(yt-dlp-<ver>) + chmod 0755
         → 切换 current 软链接指向新版本
         → 清理:仅保留最近两个 yt-dlp-* 版本
失败(网络/资产缺失/SHA256/FS)→ 冒泡到 update.ts → console.error + exit(1)
```

**流式(runner 不兜底):**
```
runStream(["-o","-", url, ...proxyArgs])   // 同步返回,进程已 spawn
  → { stdout, stderr, exited }
调用方: stdout 作 COS putObject Body → await exited
  → exited !== 0 → 调用方负责删除/重传(runner 不处理截断)
```

## Decisions

- **D1 单一 spawn 后端(child_process)**:缓冲 `run` 收集 chunk 于 `close` 组装 `ProcessResult`;流式 `runStream` 直接暴露原生 `Readable`。理由:一套原语、原生 Node 流便于管道、Bun 支持 `node:child_process`。
- **D2 runStream 返回轻量句柄(方案 A)**:`{stdout,stderr,exited}`,不泄漏 `ChildProcess` 类型。契合 COS `Body: stdout` 用法。
- **D3 流式失败不兜底(方案 A)**:runner 只如实暴露 `exited`,截断/重传由调用方处理。保持 runner 无状态、单一职责。
- **D4 版本相等判断**:yt-dlp 用日期 tag,`current` tag ≠ 最新 tag 即升级,无需语义比较,与现有已测行为一致。
- **D5 cron 失败即非 0 退出 + 纯文本 stderr**:不引入结构化日志,与项目其余 `console` 用法一致。
- **D6 toolDir 纯函数底座**:service 与 updater 共用、互不依赖,运行时不牵连网络模块。
- **D7 复用现有下载/校验/清理算法**:平台资产选择、SHA256 解析、保留最近两版逻辑迁移自现有已测实现,重写聚焦结构解耦而非算法重造。

## Testing Strategy

- `toolDir`:纯函数单测(默认路径、`YT_DLP_TOOL_DIR` 覆盖、current/版本名解析)。
- `YtDlpService`:`mkdtemp` 临时目录 + 软链接;断言 current 可用返回路径(无网络)、current 缺失抛错。
- `updater`:注入 `fetchImpl` + 临时 toolDir,覆盖:已最新不下载 / 有新版下载→SHA256→chmod 0755→切 current / SHA256 失败不切 / proxy 透传(断言 fetch 收到的 proxy)/ 仅保留最近两版。
- `runner`:**假二进制脚本**——测试写入带 shebang 的可执行小脚本(按参数产出已知 stdout/stderr/退出码),`new YtDlpRunner(fakeScriptPath)` 直接 spawn。验证 `run` 缓冲聚合、`runStream` 流内容 + `await exited` 退出码 + proxy/参数原样传递。

## Risks / Trade-offs

- [运行时从未跑过 cron → `current` 不存在导致 `getBinaryPath()` 失败] → 抛可读错误提示先执行更新任务;README 给出首次初始化命令。
- [runner 切 child_process 的 spawn/背压差异] → 假二进制脚本测试真实验证流与退出码;不依赖真实网络/yt-dlp。
- [流式 `-o -` 中途失败产生截断对象] → 约定调用方校验 `exited` 后处理(runner 不兜底),已在 delta spec 场景固化。
- [范围收敛后删除旧 `ytDlpManager.ts` → `index.ts` 暂时引用失效] → 属可接受(用户后续重构调用方);受影响点:`index.ts` 的 `ensureYtDlp` 调用与 `new YtDlpRunner(...)` 注入。验证以模块自身测试为准。

## Migration Plan

1. 扩展 `src/types.ts` 的 `ProcessRunner`(新增 `runStream` 与 `ProcessStream`)。
2. 新增 `toolDir.ts` / `ytDlpService.ts` / `updater.ts` / `update.ts` 及测试。
3. 重写 `runner.ts`(child_process,`run` + `runStream`,移除硬编码 `"yt-dlp"` 默认)。
4. 删除旧 `ytDlpManager.ts` 及其测试。
5. README 补充 cron 更新命令与首次初始化步骤。
- 回滚:恢复 `ytDlpManager.ts` 与 `runner.ts` 即可;工具目录数据结构不变(`yt-dlp-<version>` + `current`)。

## Open Questions

- 无(open 阶段与本轮 brainstorming 已澄清)。
