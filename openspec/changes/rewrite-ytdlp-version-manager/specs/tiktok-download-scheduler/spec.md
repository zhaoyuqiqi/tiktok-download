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
