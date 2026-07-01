## 1. 工具目录与路径解析

- [x] 1.1 实现工具目录解析(默认 `/opt/yt-dlp` / Windows `C:\opt\yt-dlp`,环境变量覆盖)与 `current`/版本名解析工具(供 service 与 updater 复用)
- [ ] 1.2 为路径/版本名解析编写单元测试(current 指向解析、环境变量覆盖)

## 2. YtDlpService(运行时)

- [x] 2.1 编写 `YtDlpService.getBinaryPath()` 测试:current 可用返回路径且不联网;current 缺失抛明确错误
- [x] 2.2 实现 `YtDlpService` 类(解析 current、校验存在、无网络),导出供调用方使用

## 3. 更新入口(cron / 联网)

- [x] 3.1 编写 `updater` 测试(注入 `fetchImpl`):已是最新不下载;有新版下载→SHA256→chmod 0755→切换 current;SHA256 失败不切换;proxy 参数透传;仅保留最近两个版本
- [x] 3.2 实现 `updater.ts`(fetch release、平台资产选择、SHA256 校验、chmod、切换 current、清理旧版本、支持 proxy)
- [x] 3.3 实现 `update.ts` cron 可执行入口(解析 `--proxy` 并调用 updater,失败非 0 退出)

## 4. Runner 后端切换与流式输出

- [x] 4.1 在 `src/types.ts` 扩展 `ProcessRunner`:新增流式方法(如 `runStream(args): ProcessStream`),定义 `ProcessStream`(`stdout`/`stderr` 为 Node `Readable`,`exited: Promise<number>`);`run` 缓冲签名保持不变
- [x] 4.2 编写 runner 测试:缓冲 `run` 行为(切 child_process 后 parse/download 仍通过);流式 `runStream` 输出 `yt-dlp -o -` 内容并可获取退出码;proxy 透传
- [x] 4.3 重写 `runner.ts`:spawn 后端整体改为 `node:child_process.spawn`,实现缓冲 `run` 与流式 `runStream`;移除硬编码 `"yt-dlp"` 默认值,二进制路径由调用方(经 YtDlpService)提供

## 5. 清理与验证

- [ ] 5.1 删除旧 `ytDlpManager.ts` 及其测试(能力已迁移到 service/updater)
- [ ] 5.2 更新 README,补充 cron 更新命令与首次初始化步骤
- [ ] 5.3 运行 `bun test src/ytdlp-manager/` 模块级验证通过
