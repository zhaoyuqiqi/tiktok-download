# Brainstorm Summary

- Change: rewrite-ytdlp-version-manager
- Date: 2026-07-01

## 确认的技术方案

### 已确认
- **runStream 接口(方案 A)**:`ProcessRunner` 新增 `runStream(args): ProcessStream`,同步返回(进程已 spawn)。`ProcessStream = { stdout: Readable; stderr: Readable; exited: Promise<number> }`。不泄漏 `ChildProcess` 类型。典型用法:`stream.stdout` 直接作为 COS `putObject` 的 `Body`,`await stream.exited` 判断成功。
- **流式失败处理(方案 A)**:runner 只如实暴露 `stdout/stderr/exited`,不兜底。中途失败(非 0 退出)导致的截断/重传由调用方按 `exited` 结果处理(如删除 COS 对象)。runner 保持无状态、单一职责。
- **spawn 后端**:整个 runner 切 `node:child_process.spawn`,缓冲 `run` 与流式 `runStream` 共用后端;`run` 签名保持 `Promise<ProcessResult>` 不变。

- **模块拆分(方案 A)· 4 文件**:
  - `toolDir.ts` — 无依赖纯函数:解析 toolDir(默认 /opt/yt-dlp,Windows C:\opt\yt-dlp,环境变量覆盖)、current 路径、版本名解析。service 与 updater 共用。
  - `ytDlpService.ts` — `YtDlpService` 类,依赖 toolDir,运行时解析 current 路径,不联网。
  - `updater.ts` — `updateYtDlp(opts)` 联网更新,依赖 toolDir。
  - `update.ts` — cron 入口,解析 `--proxy` 调 updater。
  - `runner.ts` — child_process spawn,`run` + `runStream`。
- **版本比较(方案 A)**:字符串相等判断(current tag ≠ 最新 tag 即升级),与现有已测行为一致;yt-dlp 用日期 tag,无需语义比较。
- **cron 失败退出码(方案 A)**:任何失败 `console.error` + `process.exit(1)`,成功 exit 0;不引入结构化日志。
- **范围收敛(用户指示)**:只交付 `src/ytdlp-manager/` 模块本身 + 测试,自成一体、可独立测试通过。**不改 index.ts / 其他调用方装配**(用户后续自行重构),**不考虑向后兼容**。删除旧 `ytDlpManager.ts` 可能使 index.ts 暂时引用失效——属可接受,需显式列出受影响调用点。

- **测试策略(方案 A)**:runner 用「假二进制脚本」——测试写入带 shebang 的可执行小脚本,按参数产出已知 stdout/stderr/退出码,`new YtDlpRunner(fakeScriptPath)` 直接 spawn,真实验证 child_process 的流/背压/退出码,无需 yt-dlp/网络。

## 关键取舍与风险

- 流式 `-o -` 边下边传:yt-dlp 中途失败会产生截断对象;约定由调用方校验 `exited` 后处理(runner 不兜底)。
- runner 由 Bun.spawn 切 child_process.spawn:缓冲路径由现有 parse/download 测试守护 + 假二进制脚本测试防回归。
- 范围收敛后删除旧 `ytDlpManager.ts` 会使 index.ts 暂时引用失效(用户后续重构调用方),验证以模块自身测试为准。

## 测试策略

- `toolDir`:纯函数单测(默认路径、环境变量覆盖、current/版本名解析)。
- `YtDlpService`:mkdtemp 临时目录 + 软链接,断言路径解析与 current 缺失报错,不联网。
- `updater`:注入 `fetchImpl` + 临时 toolDir,覆盖 已最新不下载 / 有新版下载校验切换 / SHA256 失败不切 / proxy 透传 / 仅留两版。
- `runner`:假二进制脚本,验证 `run` 缓冲聚合 与 `runStream` 流内容 + 退出码 + proxy 参数传递。

## Spec Patch

- 拟回写 delta spec:在「流式下载输出」Requirement 增加一个边界场景——流式进程非 0 退出时,`exited` 反映该退出码(调用方据此判断截断/重传)。属补充验收场景,不改结构/范围。
