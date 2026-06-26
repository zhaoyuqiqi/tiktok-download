## 1. 项目骨架与类型

- [x] 1.1 创建 `src/types.ts`(或在各模块内)定义 `VideoInfo`、`Task`、`TaskStatus`、`Uploader`、CLI 配置等核心类型
- [x] 1.2 启动时检测 `yt-dlp` 可用性的工具函数(缺失则报错退出)

## 2. 解析模块(parser)

- [x] 2.1 实现 `parser` 用 `yt-dlp -J` 解析 URL,返回 `VideoInfo[]`
- [x] 2.2 自动识别单视频 vs 用户主页(entries 展开),`--limit N` 仅多视频生效(`-I :N`)

## 3. 任务模块(task)

- [x] 3.1 实现 `Task` 模型与状态流转(pending/running/success/failed + attempts)
- [x] 3.2 实现内存 `TaskQueue`(取下一个任务、状态更新、汇总统计)

## 4. 上传模块(uploader)

- [x] 4.1 定义 `Uploader` 接口 `upload(filePath): Promise<void>` 并实现 `NoopUploader` 桩

## 5. 执行模块(worker)

- [x] 5.1 实现 `worker`:对单个 Task 用 `Bun.spawn` 启动一个 yt-dlp 进程下载到 `./output`
- [x] 5.2 下载成功后获取实际文件路径(`--print after_move:filepath`)供上传使用

## 6. 调度模块(scheduler)

- [x] 6.1 实现固定 N 个 Worker 循环从队列取任务,保证活跃进程数 ≤ workers
- [x] 6.2 失败重试逻辑(attempts < retry 重试,否则标 failed)
- [x] 6.3 下载成功后异步 fire-and-forget 调用 `uploader.upload`,收集 in-flight 上传 Promise
- [x] 6.4 全部任务结束后等待 in-flight 上传收敛再返回

## 7. CLI 入口

- [x] 7.1 实现 `download <url> [--limit] [--workers 2] [--retry 2] [-o ./output]` 参数解析
- [x] 7.2 组装 parser → task → scheduler → uploader,运行并打印汇总(成功/失败计数)

## 8. 测试与验证

- [x] 8.1 task/queue 与 scheduler 并发约束的单元测试(mock worker,验证活跃数 ≤ workers、重试、上传不阻塞)
- [x] 8.2 parser 解析逻辑测试(mock yt-dlp -J 输出:单视频 / entries / limit)
- [ ] 8.3 端到端冒烟:对真实/受控 URL 跑一次,确认输出落在 ./output 且上传 hook 被调用

## 9. 代理支持(范围扩展:用户要求 --proxy)

- [ ] 9.1 `Config` 增加 `proxy?`;`parse` 与 `download` 在 proxy 存在时透传 `--proxy <url>` 给 yt-dlp(含 parser/worker 单测)
- [ ] 9.2 `parseArgs` 解析 `--proxy`;CLI 组装时把 proxy 传入 parse 与 download 闭包(含 cli 单测)
