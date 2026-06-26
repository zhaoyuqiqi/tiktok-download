# Brainstorm Summary

- Change: tiktok-download-scheduler
- Date: 2026-06-26

## 确认的技术方案

运行时 Bun + TypeScript,不引入第三方 npm 依赖,外部依赖 yt-dlp 2026.06.09(已在 PATH)。

模块(低耦合,均通过显式接口协作,依赖注入便于测试):
- `types.ts`:`VideoInfo`、`Task`、`TaskStatus`、`Uploader`、`Config`、`ProcessRunner` 等核心类型
- `runner.ts`:`ProcessRunner` 接口 + 基于 `Bun.spawn` 的默认实现(封装 yt-dlp 调用,返回 {code, stdout, stderr})。**唯一接触子进程的地方**,测试时可注入假实现
- `parser.ts`:输入 url+limit,调 `yt-dlp -J --flat-playlist [-I :N]`,解析 JSON;`_type==='playlist'` 且有 `entries[]` → 多视频(取 entry.url/id),否则单视频。产出 `VideoInfo[]`
- `task.ts`:`Task`(id/url/title?/status/attempts)+ 内存 `TaskQueue`(next() 取下一个 pending、状态更新、汇总统计)。纯数据,JS 单线程下指针取任务天然安全
- `worker.ts`:对单个 Task 调 runner 执行 `yt-dlp -P ./output --print after_move:filepath <url>`,成功时从 stdout 取最终文件路径,返回 {ok, filePath?}。无状态
- `scheduler.ts`:启动 N 个 worker 循环 `while(task=queue.next())`,并发=N;失败重试(attempts<retry 则固定延迟 2s 后重试,否则 failed);成功后 fire-and-forget `uploader.upload(filePath).catch(log)`,收集 in-flight upload promise;全部任务结束后 await 所有 upload promise 再返回
- `uploader.ts`:`interface Uploader { upload(filePath): Promise<void> }` + `NoopUploader` 桩
- `cli.ts` / `index.ts`:解析 `download <url> [--limit N] [--workers 2] [--retry 2]`,检测 yt-dlp 可用(`Bun.which`),组装运行,打印成功/失败汇总

### 已确认的关键实现决策
1. 文件路径获取:下载命令加 `--print after_move:filepath`,捕获 stdout 最后一行作为实际路径
2. 列表解析:`--flat-playlist` 快速解析,只取 id/url,逐个下载(完整 metadata 下载时获取)
3. 重试退避:固定延迟(默认 2s)
4. 输出:`-P ./output` 设定下载目录,文件名用 yt-dlp 默认模板(`%(title)s [%(id)s].%(ext)s`)

## 关键取舍与风险

- 并发模型:N 个 worker 循环 + 共享队列(对应"worker 数=并发数"),弃用 Promise.all+信号量
- per-video 一个 yt-dlp 进程,弃用单进程下整批(满足故障隔离+并发控制)
- fire-and-forget 上传:进程退出前 scheduler 统一 await in-flight upload promise,避免上传丢失
- [风险] yt-dlp 不在 PATH → 启动 Bun.which 检测,缺失明确报错退出(exit≠0)
- [风险] 限流 → workers 默认 2 保守值 + 固定延迟重试
- [风险] flat-playlist 的 entry 可能只有 id 无完整 url → 解析时 url 优先 entry.url,缺失用 entry.id 兜底

## 测试策略

- 单元(bun test):
  - `parser`:注入假 ProcessRunner,喂单视频 JSON / playlist+entries JSON / 验证 limit 透传 `-I :N`
  - `task/queue`:next() 顺序、状态流转、汇总统计
  - `scheduler`:注入假 download 函数,断言①任意时刻活跃数≤workers(并发计数器峰值)②失败重试到上限后标 failed 且不影响其他③上传 fire-and-forget 不阻塞、上传抛错不改下载成功状态④结束前等待 in-flight 上传
- 冒烟:对真实/受控 URL 跑一次,确认输出落在 ./output、上传 hook 被调用

## Spec Patch（已回写 delta spec）

- 「解析视频列表」增补场景:用户主页未指定 `--limit` 时下载全部条目 —— 已写入 specs/tiktok-download-scheduler/spec.md
