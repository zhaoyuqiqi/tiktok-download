---
change: rewrite-ytdlp-version-manager
design-doc: docs/superpowers/specs/2026-07-01-rewrite-ytdlp-version-manager-design.md
base-ref: 932cfa4b4e1cacdc3bbc093a844fccc70cf4f418
---

# 重写 yt-dlp 版本管理器 实现计划

> **面向执行 agent:** 必需子技能:使用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现本计划。步骤用复选框(`- [ ]`)语法追踪进度。

**目标:** 把「运行时确保二进制」与「联网检查/下载更新」彻底解耦,`YtDlpService`(运行时、不联网)解析 `current` 软链接给出二进制路径,`updateYtDlp`(cron、联网、支持 proxy)负责下载/校验/切换/清理,并把 runner 的 spawn 后端切到 `node:child_process` 且新增流式 `runStream`。

**架构:** `src/ytdlp-manager/` 下按职责拆分:`toolDir.ts`(纯函数底座,无依赖)被 service 与 updater 共用;`ytDlpService.ts`(运行时类,不联网)只解析 `current`;`updater.ts` + `update.ts`(cron 入口)联网更新;`runner.ts` 重写为 `child_process.spawn`,同时提供缓冲 `run` 与流式 `runStream`。service 与 updater 互不依赖,运行时代码不牵连网络模块。

**技术栈:** Bun(运行时 + `bun test` + `bun` 执行文件)、TypeScript、`node:child_process`、`node:fs/promises`、`node:stream`、`crypto.subtle`(SHA256)。

## 全局约束(Global Constraints)

以下为项目级约束,每个任务的要求都隐含包含本节。所有值逐字复制自 spec/design/CLAUDE.md:

- 运行时用 **Bun**:测试用 `bun test`,执行文件用 `bun <file>`,不要用 node/ts-node/jest/vitest。
- **TDD 模式(tdd)**:每个任务先写失败测试,再写实现;先运行测试确认 FAIL,实现后确认 PASS。
- 工具目录默认 `/opt/yt-dlp`,Windows 默认 `C:\opt\yt-dlp`,环境变量 `YT_DLP_TOOL_DIR` 覆盖。不使用 PATH 中全局 yt-dlp,不把二进制放项目目录内。
- 版本命名 `yt-dlp-<version>`,`current` 为指向具体版本二进制的软链接。
- 版本相等判断:**对日期 tag 做字符串相等**,不做语义比较(D4)。
- 清理:成功切换 `current` 后**仅保留最近两个**版本(含新切换版本),不删除 `current` 指向的版本。
- SHA256 校验用 `crypto.subtle.digest("SHA-256", ...)`;`chmod` 目标权限为 `0o755`。
- GitHub Release API:`https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest`;校验文件资产名匹配 `/sha2[-_]?256sums/i`。
- 平台资产选择:`darwin` → `yt-dlp_macos`;`win32` → `yt-dlp.exe`;其他 → `yt-dlp`。
- `runStream` 返回轻量句柄 `{ stdout, stderr, exited }`(方案 A),同步返回(进程已 spawn),**不泄漏** `ChildProcess` 类型;runner **不**对流式截断兜底,调用方自行检查 `exited`(D2/D3)。
- **范围(SCOPE,用户显式指令):** 仅交付 `src/ytdlp-manager/` 模块 + `src/types.ts` 的 `ProcessRunner` 扩展 + 相应测试;删除旧 `ytDlpManager.ts` 及其测试。**不修改** `src/index.ts` 或其他调用方装配(用户后续自行重构),tasks.md 第 5 组「装配接入」不在本计划范围。无向后兼容。验证以模块自身测试通过为准(对 ytdlp-manager 测试跑 `bun test`),**不**要求整仓构建。
- 不引入结构化日志;cron 失败即 `console.error` + `process.exit(1)`,与项目其余 `console` 用法一致(D5)。
- 复用旧 `ytDlpManager.ts` 中已测的下载/SHA256 解析/清理算法(D7),重写聚焦结构解耦而非算法重造。

---

## 执行清单

- [x] Task 1 — toolDir 纯函数底座
- [ ] Task 2 — YtDlpService(运行时,不联网)
- [ ] Task 3 — types 扩展 + runner 重写(run + runStream)
- [ ] Task 4 — updater(联网)+ update.ts(cron 入口)
- [ ] Task 5 — 删除旧实现 + README + 模块级验证

## 文件结构

- `src/ytdlp-manager/toolDir.ts`(新建)—— 纯函数:`resolveToolDir` / `currentLinkPath` / `parseVersionFromTarget` / `versionBinName`。无外部依赖,被 service 与 updater 共用。
- `src/ytdlp-manager/toolDir.test.ts`(新建)—— toolDir 纯函数单测。
- `src/ytdlp-manager/ytDlpService.ts`(新建)—— `YtDlpService` 类(运行时,不联网)。
- `src/ytdlp-manager/ytDlpService.test.ts`(新建)—— 临时目录 + 软链接测试。
- `src/ytdlp-manager/updater.ts`(新建)—— `updateYtDlp(opts)`(联网,支持 proxy,可注入 fetchImpl)。
- `src/ytdlp-manager/updater.test.ts`(新建)—— 注入 fetchImpl + 临时 toolDir 测试。
- `src/ytdlp-manager/update.ts`(新建)—— cron 可执行入口(解析 `--proxy`)。
- `src/ytdlp-manager/runner.ts`(重写)—— `YtDlpRunner`,`child_process.spawn`,`run` + `runStream`。
- `src/ytdlp-manager/runner.test.ts`(新建)—— 假二进制脚本 spawn 测试。
- `src/types.ts`(修改,27-29 行)—— 扩展 `ProcessRunner`,新增 `ProcessStream`。
- `src/ytdlp-manager/ytDlpManager.ts`(删除)。
- `src/ytdlp-manager/ytDlpManager.test.ts`(删除)。
- `README.md`(修改)—— 补充 cron 更新命令与首次初始化步骤。

依赖顺序:Task 1(toolDir)→ Task 2(YtDlpService)+ Task 4(updater/update)并行可行(都只依赖 toolDir)→ Task 3(types + runner run/runStream)独立于 1/2/4 → Task 5(清理旧文件 + README + 全量验证)最后。

---

### Task 1: toolDir 纯函数底座

**Files:**
- Create: `src/ytdlp-manager/toolDir.ts`
- Test: `src/ytdlp-manager/toolDir.test.ts`

**Interfaces:**
- Consumes: 无(纯函数,无依赖)。
- Produces:
  - `resolveToolDir(rawToolDir?: string): string` —— 非空 rawToolDir 优先;否则读环境变量 `YT_DLP_TOOL_DIR`(非空时用它);否则按平台默认 `/opt/yt-dlp` 或 `C:\opt\yt-dlp`。
  - `currentLinkPath(toolDir: string): string` —— 返回 `<toolDir>/current`。
  - `parseVersionFromTarget(target: string): string | undefined` —— `yt-dlp-<ver>` → `<ver>`,否则 `undefined`。
  - `versionBinName(version: string): string` —— `<ver>` → `yt-dlp-<ver>`。

- [x] **Step 1: 写失败测试**

创建 `src/ytdlp-manager/toolDir.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { currentLinkPath, parseVersionFromTarget, resolveToolDir, versionBinName } from "./toolDir.ts";

const ENV_KEY = "YT_DLP_TOOL_DIR";
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
});

test("resolveToolDir 显式参数优先", () => {
  expect(resolveToolDir("/custom/tool/dir")).toBe("/custom/tool/dir");
});

test("resolveToolDir 环境变量覆盖默认值", () => {
  process.env[ENV_KEY] = "/env/tool/dir";
  expect(resolveToolDir()).toBe("/env/tool/dir");
});

test("resolveToolDir 空白参数回退到环境变量/默认", () => {
  process.env[ENV_KEY] = "/env/tool/dir";
  expect(resolveToolDir("   ")).toBe("/env/tool/dir");
});

test("resolveToolDir 无参数无环境变量时按平台给默认值", () => {
  const expected = process.platform === "win32" ? "C:\\opt\\yt-dlp" : "/opt/yt-dlp";
  expect(resolveToolDir()).toBe(expected);
});

test("currentLinkPath 拼出 <toolDir>/current", () => {
  expect(currentLinkPath("/opt/yt-dlp")).toBe(join("/opt/yt-dlp", "current"));
});

test("parseVersionFromTarget 解析出版本", () => {
  expect(parseVersionFromTarget("yt-dlp-2026.06.28")).toBe("2026.06.28");
  expect(parseVersionFromTarget("/opt/yt-dlp/yt-dlp-2026.06.28")).toBe("2026.06.28");
});

test("parseVersionFromTarget 非法名返回 undefined", () => {
  expect(parseVersionFromTarget("current")).toBeUndefined();
  expect(parseVersionFromTarget("yt-dlp-")).toBeUndefined();
});

test("versionBinName 生成二进制名", () => {
  expect(versionBinName("2026.06.28")).toBe("yt-dlp-2026.06.28");
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `bun test src/ytdlp-manager/toolDir.test.ts`
Expected: FAIL,报错 `Cannot find module './toolDir.ts'` 或导出未定义。

- [ ] **Step 3: 写最小实现**

创建 `src/ytdlp-manager/toolDir.ts`:

```ts
import { basename, join } from "node:path";

const CURRENT_LINK_NAME = "current";
const BIN_PREFIX = "yt-dlp-";
const ENV_TOOL_DIR = "YT_DLP_TOOL_DIR";

export function resolveToolDir(rawToolDir?: string): string {
  if (rawToolDir !== undefined && rawToolDir.trim() !== "") {
    return rawToolDir;
  }
  const fromEnv = process.env[ENV_TOOL_DIR];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return process.platform === "win32" ? "C:\\opt\\yt-dlp" : "/opt/yt-dlp";
}

export function currentLinkPath(toolDir: string): string {
  return join(toolDir, CURRENT_LINK_NAME);
}

export function parseVersionFromTarget(target: string): string | undefined {
  const base = basename(target);
  if (!base.startsWith(BIN_PREFIX)) {
    return undefined;
  }
  return base.slice(BIN_PREFIX.length) || undefined;
}

export function versionBinName(version: string): string {
  return `${BIN_PREFIX}${version}`;
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `bun test src/ytdlp-manager/toolDir.test.ts`
Expected: PASS(全部 8 个测试通过)。

- [ ] **Step 5: 提交**

```bash
git add src/ytdlp-manager/toolDir.ts src/ytdlp-manager/toolDir.test.ts
git commit -m "feat(ytdlp-manager): add toolDir pure-function base"
```

---

### Task 2: YtDlpService(运行时,不联网)

**Files:**
- Create: `src/ytdlp-manager/ytDlpService.ts`
- Test: `src/ytdlp-manager/ytDlpService.test.ts`

**Interfaces:**
- Consumes: `resolveToolDir`、`currentLinkPath`(来自 Task 1 `./toolDir.ts`)。
- Produces:
  - `class YtDlpService { constructor(opts?: { toolDir?: string }); getBinaryPath(): Promise<string>; }`
  - `getBinaryPath()` 行为:`readlink(current)` → 解析目标绝对路径 → 校验目标文件存在 → 返回绝对路径;`current` 缺失或目标不存在 → `throw new Error(...)`,错误信息提示先运行更新任务;全程不发起网络请求。

- [ ] **Step 1: 写失败测试**

创建 `src/ytdlp-manager/ytDlpService.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { YtDlpService } from "./ytDlpService.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function tempToolDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yt-dlp-service-"));
  roots.push(root);
  return root;
}

test("current 可用时返回绝对二进制路径且不联网", async () => {
  const root = await tempToolDir();
  const version = "2026.06.28";
  const binName = `yt-dlp-${version}`;
  await writeFile(join(root, binName), "binary");
  await symlink(binName, join(root, "current"));

  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error("不应联网");
  }) as typeof fetch;

  try {
    const service = new YtDlpService({ toolDir: root });
    const path = await service.getBinaryPath();
    expect(isAbsolute(path)).toBe(true);
    expect(path).toBe(join(root, binName));
    expect(fetchCalled).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("current 缺失时抛明确错误", async () => {
  const root = await tempToolDir();
  const service = new YtDlpService({ toolDir: root });
  await expect(service.getBinaryPath()).rejects.toThrow(/更新任务/);
});

test("current 存在但目标二进制不存在时抛错", async () => {
  const root = await tempToolDir();
  const binName = "yt-dlp-2026.06.28";
  await writeFile(join(root, binName), "binary");
  await symlink(binName, join(root, "current"));
  await unlink(join(root, binName));

  const service = new YtDlpService({ toolDir: root });
  await expect(service.getBinaryPath()).rejects.toThrow(/更新任务/);
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `bun test src/ytdlp-manager/ytDlpService.test.ts`
Expected: FAIL,`Cannot find module './ytDlpService.ts'`。

- [ ] **Step 3: 写最小实现**

创建 `src/ytdlp-manager/ytDlpService.ts`:

```ts
import { access, readlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { currentLinkPath, resolveToolDir } from "./toolDir.ts";

const MISSING_HINT = "yt-dlp current 软链接不可用,请先运行更新任务(bun run src/ytdlp-manager/update.ts)";

export class YtDlpService {
  private readonly toolDir: string;

  constructor(opts?: { toolDir?: string }) {
    this.toolDir = resolveToolDir(opts?.toolDir);
  }

  async getBinaryPath(): Promise<string> {
    const linkPath = currentLinkPath(this.toolDir);
    let target: string;
    try {
      target = await readlink(linkPath);
    } catch {
      throw new Error(`${MISSING_HINT}(缺少 current: ${linkPath})`);
    }
    const binPath = isAbsolute(target) ? target : resolve(this.toolDir, target);
    try {
      await access(binPath);
    } catch {
      throw new Error(`${MISSING_HINT}(current 目标不存在: ${binPath})`);
    }
    return binPath;
  }
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `bun test src/ytdlp-manager/ytDlpService.test.ts`
Expected: PASS(3 个测试通过)。

- [ ] **Step 5: 提交**

```bash
git add src/ytdlp-manager/ytDlpService.ts src/ytdlp-manager/ytDlpService.test.ts
git commit -m "feat(ytdlp-manager): add runtime YtDlpService resolving current symlink"
```

---

### Task 3: types 扩展 + runner 重写(run + runStream)

本任务把 `ProcessRunner` 扩展进 `src/types.ts`,并把 `runner.ts` 的 spawn 后端整体切到 `node:child_process.spawn`,实现缓冲 `run` 与流式 `runStream`。用「假二进制脚本」做确定性测试。与 Task 1/2/4 无依赖,可独立执行。

**Files:**
- Modify: `src/types.ts:27-29`(扩展 `ProcessRunner`,新增 `ProcessStream`,新增 `Readable` 导入)
- Modify(重写): `src/ytdlp-manager/runner.ts`
- Test: `src/ytdlp-manager/runner.test.ts`

**Interfaces:**
- Consumes: 无(runner 二进制路径由构造函数传入,不再硬编码 `"yt-dlp"`)。
- Produces:
  - `src/types.ts`:
    - `interface ProcessStream { stdout: Readable; stderr: Readable; exited: Promise<number>; }`(`Readable` 来自 `node:stream`)。
    - `interface ProcessRunner { run(args: string[]): Promise<ProcessResult>; runStream(args: string[]): ProcessStream; }`(`run` 签名不变)。
  - `src/ytdlp-manager/runner.ts`:`class YtDlpRunner implements ProcessRunner`,`constructor(private readonly binPath: string)`(**无默认值**),`run` 用 `child_process.spawn` 收集 chunk 于 `close` 组装 `ProcessResult`,`runStream` 同步 spawn 后返回 `{ stdout, stderr, exited }`。

- [ ] **Step 1: 扩展 `src/types.ts`**

在文件顶部加导入,并替换 `ProcessRunner`。将现有 27-29 行:

```ts
export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
}
```

替换为:

```ts
export interface ProcessStream {
  stdout: Readable;
  stderr: Readable;
  exited: Promise<number>;
}

export interface ProcessRunner {
  run(args: string[]): Promise<ProcessResult>;
  runStream(args: string[]): ProcessStream;
}
```

并在文件第 1 行前插入类型导入:

```ts
import type { Readable } from "node:stream";
```

- [ ] **Step 2: 写失败测试**

创建 `src/ytdlp-manager/runner.test.ts`。测试用一个带 shebang 的假可执行脚本,按参数产出确定的 stdout/stderr/退出码:

```ts
import { afterEach, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YtDlpRunner } from "./runner.ts";

const roots: string[] = [];
let fakeBin = "";

// 假二进制:
//   ["ok"]           -> stdout "hello-stdout", stderr "hello-stderr", exit 0
//   ["fail"]         -> stdout "partial", exit 3
//   ["echoargs",...] -> stdout 打印收到的全部参数(每行一个)
const FAKE_SCRIPT = `#!/usr/bin/env bash
mode="$1"
if [ "$mode" = "ok" ]; then
  printf 'hello-stdout'
  printf 'hello-stderr' 1>&2
  exit 0
elif [ "$mode" = "fail" ]; then
  printf 'partial'
  exit 3
elif [ "$mode" = "echoargs" ]; then
  shift
  for a in "$@"; do printf '%s\\n' "$a"; done
  exit 0
fi
exit 42
`;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "yt-dlp-runner-"));
  roots.push(root);
  fakeBin = join(root, "fake-yt-dlp.sh");
  await writeFile(fakeBin, FAKE_SCRIPT);
  await chmod(fakeBin, 0o755);
});

afterEach(async () => {
  // 保留 fakeBin 目录到 beforeAll 创建;此处不清空 roots(仅一个共享目录)
});

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("run 缓冲聚合 stdout/stderr/退出码", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const result = await runner.run(["ok"]);
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("hello-stdout");
  expect(result.stderr).toBe("hello-stderr");
});

test("run 非 0 退出码如实返回", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const result = await runner.run(["fail"]);
  expect(result.code).toBe(3);
  expect(result.stdout).toBe("partial");
});

test("run 原样透传参数(含 --proxy)", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const result = await runner.run(["echoargs", "--proxy", "http://127.0.0.1:7890", "-o", "-"]);
  expect(result.code).toBe(0);
  expect(result.stdout.split("\n").filter((l) => l !== "")).toEqual([
    "--proxy",
    "http://127.0.0.1:7890",
    "-o",
    "-",
  ]);
});

test("runStream 同步返回句柄并流出 stdout 内容 + 退出码", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const stream = runner.runStream(["ok"]);
  const [stdout, stderr, code] = await Promise.all([
    readAll(stream.stdout),
    readAll(stream.stderr),
    stream.exited,
  ]);
  expect(stdout).toBe("hello-stdout");
  expect(stderr).toBe("hello-stderr");
  expect(code).toBe(0);
});

test("runStream 非 0 退出码经 exited 暴露(不兜底)", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const stream = runner.runStream(["fail"]);
  const stdout = await readAll(stream.stdout);
  const code = await stream.exited;
  expect(stdout).toBe("partial");
  expect(code).toBe(3);
});

test("runStream 原样透传参数(含 --proxy)", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const stream = runner.runStream(["echoargs", "--proxy", "http://127.0.0.1:7890"]);
  const stdout = await readAll(stream.stdout);
  await stream.exited;
  expect(stdout.split("\n").filter((l) => l !== "")).toEqual(["--proxy", "http://127.0.0.1:7890"]);
});
```

- [ ] **Step 3: 运行测试确认 FAIL**

Run: `bun test src/ytdlp-manager/runner.test.ts`
Expected: FAIL,`runStream` 未定义 / 类型不匹配(旧 runner 无 `runStream`,构造函数仍有默认值)。

- [ ] **Step 4: 重写 `src/ytdlp-manager/runner.ts`**

完整替换为:

```ts
import { spawn } from "node:child_process";
import type { ProcessResult, ProcessRunner, ProcessStream } from "../types.ts";

export class YtDlpRunner implements ProcessRunner {
  constructor(private readonly binPath: string) {}

  async run(args: string[]): Promise<ProcessResult> {
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(Buffer.from(chunk)));

    const code: number = await new Promise((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
    });

    return {
      code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    };
  }

  runStream(args: string[]): ProcessStream {
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited: Promise<number> = new Promise((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
    };
  }
}
```

- [ ] **Step 5: 运行测试确认 PASS**

Run: `bun test src/ytdlp-manager/runner.test.ts`
Expected: PASS(6 个测试通过)。

- [ ] **Step 6: 提交**

```bash
git add src/types.ts src/ytdlp-manager/runner.ts src/ytdlp-manager/runner.test.ts
git commit -m "feat(ytdlp-manager): rewrite runner on child_process with buffered run + streaming runStream"
```

---

### Task 4: updater(联网)+ update.ts(cron 入口)

复用旧 `ytDlpManager.ts` 的下载/校验/清理算法(D7),重构为不联网的 `YtDlpService` 之外的独立 `updateYtDlp`,新增 `proxy` 透传,并提供 cron 可执行入口 `update.ts`。

**Files:**
- Create: `src/ytdlp-manager/updater.ts`
- Create: `src/ytdlp-manager/update.ts`
- Test: `src/ytdlp-manager/updater.test.ts`

**Interfaces:**
- Consumes: `resolveToolDir`、`currentLinkPath`、`parseVersionFromTarget`、`versionBinName`(来自 Task 1 `./toolDir.ts`)。
- Produces:
  - `interface UpdateOptions { toolDir?: string; proxy?: string; platform?: NodeJS.Platform; fetchImpl?: typeof fetch; }`
  - `interface UpdateResult { updated: boolean; latestVersion: string; localVersion?: string; }`
  - `function updateYtDlp(opts?: UpdateOptions): Promise<UpdateResult>`
  - `update.ts`:cron 入口。解析 `--proxy <url>` → 调用 `updateYtDlp({ proxy })`;成功 `exit 0`;任何失败 `console.error(err)` + `process.exit(1)`。

**proxy 透传实现说明:** Bun 的 `fetch` 支持 `{ proxy: string }` 选项。`updateYtDlp` 在每次 `fetchImpl(url, init)` 时,若 `opts.proxy` 有值,则把 `proxy` 放进 init 对象一并传入。测试用注入的 `fetchImpl` 断言收到的第二参数 `init.proxy` 等于给定值。

- [ ] **Step 1: 写失败测试**

创建 `src/ytdlp-manager/updater.test.ts`(mock 结构复用旧 `ytDlpManager.test.ts` 的 `MockResponse`/`makeFetchMock`,并扩展记录 `init.proxy`):

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateYtDlp } from "./updater.ts";

interface MockResponseInit {
  ok: boolean;
  status?: number;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

class MockResponse {
  constructor(private readonly init: MockResponseInit) {}
  get ok(): boolean { return this.init.ok; }
  get status(): number { return this.init.status ?? 200; }
  async json(): Promise<unknown> { return JSON.parse(this.init.bodyText ?? "{}"); }
  async text(): Promise<string> {
    if (this.init.bodyText !== undefined) return this.init.bodyText;
    return new TextDecoder().decode(this.init.bodyBytes ?? new Uint8Array());
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.init.bodyBytes !== undefined) return toArrayBuffer(this.init.bodyBytes);
    return toArrayBuffer(new TextEncoder().encode(this.init.bodyText ?? ""));
  }
}

interface FetchCall { url: string; proxy?: string; }

function makeFetchMock(map: Record<string, MockResponseInit>, calls: FetchCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, proxy: init?.proxy });
    const hit = map[url];
    if (hit === undefined) return new MockResponse({ ok: false, status: 404 }) as unknown as Response;
    return new MockResponse(hit) as unknown as Response;
  }) as typeof fetch;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

async function tempToolDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "yt-dlp-updater-"));
  roots.push(root);
  return root;
}

function releaseBody(tag: string): string {
  return JSON.stringify({
    tag_name: tag,
    assets: [
      { name: "yt-dlp_macos", browser_download_url: "https://example.com/yt-dlp_macos" },
      { name: "SHA2-256SUMS", browser_download_url: "https://example.com/SHA2-256SUMS" },
    ],
  });
}

test("已是最新版本时不下载", async () => {
  const root = await tempToolDir();
  const version = "2026.06.28";
  await writeFile(join(root, `yt-dlp-${version}`), "existing");
  await symlink(`yt-dlp-${version}`, join(root, "current"));

  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock({ [API]: { ok: true, bodyText: releaseBody(version) } }, calls);

  const result = await updateYtDlp({ toolDir: root, platform: "darwin", fetchImpl: fetchMock });
  expect(result.updated).toBe(false);
  expect(result.localVersion).toBe(version);
  expect(calls.map((c) => c.url)).toEqual([API]);
});

test("有新版本时下载+SHA256+chmod 0755+切换 current+只留两版", async () => {
  const root = await tempToolDir();
  await writeFile(join(root, "yt-dlp-2026.06.10"), "old1");
  await writeFile(join(root, "yt-dlp-2026.06.20"), "old2");
  await symlink("yt-dlp-2026.06.20", join(root, "current"));

  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const hash = await sha256Hex(binary);
  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/SHA2-256SUMS": { ok: true, bodyText: `${hash}  yt-dlp_macos\n` },
    },
    calls,
  );

  const result = await updateYtDlp({ toolDir: root, platform: "darwin", fetchImpl: fetchMock });
  expect(result.updated).toBe(true);
  expect(await readlink(join(root, "current"))).toBe("yt-dlp-2026.06.28");

  const names = (await readdir(root)).sort();
  expect(names).toContain("yt-dlp-2026.06.20");
  expect(names).toContain("yt-dlp-2026.06.28");
  expect(names).not.toContain("yt-dlp-2026.06.10");

  const mode = (await stat(join(root, "yt-dlp-2026.06.28"))).mode & 0o777;
  expect(mode).toBe(0o755);
});

test("SHA256 校验失败时报错且不切 current", async () => {
  const root = await tempToolDir();
  await writeFile(join(root, "yt-dlp-2026.06.20"), "old");
  await symlink("yt-dlp-2026.06.20", join(root, "current"));

  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: `0000000000000000000000000000000000000000000000000000000000000000  yt-dlp_macos\n`,
      },
    },
    [],
  );

  await expect(
    updateYtDlp({ toolDir: root, platform: "darwin", fetchImpl: fetchMock }),
  ).rejects.toThrow("SHA256 校验失败");
  expect(await readlink(join(root, "current"))).toBe("yt-dlp-2026.06.20");
});

test("proxy 透传给所有 fetch 调用", async () => {
  const root = await tempToolDir();
  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const hash = await sha256Hex(binary);
  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/SHA2-256SUMS": { ok: true, bodyText: `${hash}  yt-dlp_macos\n` },
    },
    calls,
  );

  await updateYtDlp({ toolDir: root, platform: "darwin", proxy: "http://127.0.0.1:7890", fetchImpl: fetchMock });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.proxy).toBe("http://127.0.0.1:7890");
  }
});
```

- [ ] **Step 2: 运行测试确认 FAIL**

Run: `bun test src/ytdlp-manager/updater.test.ts`
Expected: FAIL,`Cannot find module './updater.ts'`。

- [ ] **Step 3: 写 `src/ytdlp-manager/updater.ts` 实现**

复用旧算法(SHA256 解析、平台资产选择、清理保留两版),把网络调用统一走 `withProxy` 辅助并透传 proxy,路径工具改用 `./toolDir.ts`:

```ts
import { access, chmod, mkdir, readdir, readlink, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentLinkPath, parseVersionFromTarget, resolveToolDir, versionBinName } from "./toolDir.ts";

const LATEST_RELEASE_API = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface ReleaseResponse {
  tag_name: string;
  assets: ReleaseAsset[];
}

export interface UpdateOptions {
  toolDir?: string;
  proxy?: string;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
}

export interface UpdateResult {
  updated: boolean;
  latestVersion: string;
  localVersion?: string;
}

function pickAssetName(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "yt-dlp_macos";
    case "win32":
      return "yt-dlp.exe";
    default:
      return "yt-dlp";
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readCurrentVersion(toolDir: string): Promise<string | undefined> {
  try {
    const target = await readlink(currentLinkPath(toolDir));
    return parseVersionFromTarget(target);
  } catch {
    return undefined;
  }
}

function parseChecksumMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match === null) continue;
    const hash = match[1]?.toLowerCase();
    const file = match[2]?.trim();
    if (hash !== undefined && file !== undefined && file !== "") map.set(file, hash);
  }
  return map;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

async function switchCurrentSymlink(toolDir: string, targetFileName: string): Promise<void> {
  const linkPath = currentLinkPath(toolDir);
  await safeUnlink(linkPath);
  await symlink(targetFileName, linkPath);
}

async function cleanupOldVersions(toolDir: string): Promise<void> {
  const names = await readdir(toolDir);
  const versions = names.filter((name) => name.startsWith("yt-dlp-"));
  versions.sort((a, b) => b.localeCompare(a));
  await Promise.all(versions.slice(2).map((name) => safeUnlink(join(toolDir, name))));
}

function findChecksumAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => /sha2[-_]?256sums/i.test(asset.name));
}

export async function updateYtDlp(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const toolDir = resolveToolDir(opts.toolDir);
  const proxy = opts.proxy;

  const doFetch = (url: string): ReturnType<typeof fetch> => {
    const init: RequestInit & { proxy?: string; headers?: Record<string, string> } = {};
    if (proxy !== undefined && proxy !== "") init.proxy = proxy;
    return fetchImpl(url, init);
  };
  const doFetchApi = (url: string): ReturnType<typeof fetch> => {
    const init: RequestInit & { proxy?: string; headers?: Record<string, string> } = {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "tiktok-downloader" },
    };
    if (proxy !== undefined && proxy !== "") init.proxy = proxy;
    return fetchImpl(url, init);
  };

  await mkdir(toolDir, { recursive: true });

  const localVersion = await readCurrentVersion(toolDir);

  const apiResp = await doFetchApi(LATEST_RELEASE_API);
  if (!apiResp.ok) throw new Error(`获取 yt-dlp 最新版本失败: HTTP ${apiResp.status}`);
  const data = (await apiResp.json()) as Partial<ReleaseResponse>;
  if (typeof data.tag_name !== "string" || !Array.isArray(data.assets)) {
    throw new Error("GitHub Release 响应缺少必要字段(tag_name/assets)");
  }
  const release: ReleaseResponse = { tag_name: data.tag_name, assets: data.assets as ReleaseAsset[] };
  const latestVersion = release.tag_name;

  const latestBinName = versionBinName(latestVersion);
  const latestBinPath = join(toolDir, latestBinName);

  if (localVersion === latestVersion && (await fileExists(latestBinPath))) {
    return { updated: false, latestVersion, localVersion };
  }

  const assetName = pickAssetName(platform);
  const binaryAsset = release.assets.find((asset) => asset.name === assetName);
  if (binaryAsset === undefined) throw new Error(`未在 release 资产中找到平台二进制: ${assetName}`);

  const checksumAsset = findChecksumAsset(release.assets);
  if (checksumAsset === undefined) throw new Error("未在 release 资产中找到 SHA256 校验文件");

  const [binResp, checksumResp] = await Promise.all([
    doFetch(binaryAsset.browser_download_url),
    doFetch(checksumAsset.browser_download_url),
  ]);
  if (!binResp.ok) throw new Error(`下载 yt-dlp 二进制失败: HTTP ${binResp.status}`);
  if (!checksumResp.ok) throw new Error(`下载 SHA256 校验文件失败: HTTP ${checksumResp.status}`);

  const [binBuf, checksumText] = await Promise.all([binResp.arrayBuffer(), checksumResp.text()]);
  const expectedHash = parseChecksumMap(checksumText).get(assetName);
  if (expectedHash === undefined) throw new Error(`SHA256 校验文件中缺少 ${assetName} 的摘要`);

  const binBytes = new Uint8Array(binBuf);
  const actualHash = await sha256Hex(binBytes);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 校验失败: expected=${expectedHash}, actual=${actualHash}`);
  }

  await writeFile(latestBinPath, binBytes);
  await chmod(latestBinPath, 0o755);
  await switchCurrentSymlink(toolDir, latestBinName);
  await cleanupOldVersions(toolDir);

  return { updated: true, latestVersion, localVersion };
}
```

- [ ] **Step 4: 运行测试确认 PASS**

Run: `bun test src/ytdlp-manager/updater.test.ts`
Expected: PASS(4 个测试通过)。

- [ ] **Step 5: 写 cron 入口 `src/ytdlp-manager/update.ts`**

```ts
import { updateYtDlp } from "./updater.ts";

function parseProxy(argv: string[]): string | undefined {
  const idx = argv.indexOf("--proxy");
  if (idx === -1) return undefined;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--proxy 需要一个 URL 参数");
  }
  return value;
}

async function main(): Promise<void> {
  const proxy = parseProxy(process.argv.slice(2));
  const result = await updateYtDlp({ proxy });
  if (result.updated) {
    console.log(`yt-dlp 已更新到 ${result.latestVersion}(原 ${result.localVersion ?? "无"})`);
  } else {
    console.log(`yt-dlp 已是最新版本 ${result.latestVersion},无需更新`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 6: 手动 smoke 校验入口可解析(不联网)**

Run: `bun run src/ytdlp-manager/update.ts --proxy`
Expected: 打印 `--proxy 需要一个 URL 参数` 并以退出码 1 结束(验证参数解析与失败退出路径;正常联网更新由 CI/生产 cron 触发,不在本地必测范围)。

- [ ] **Step 7: 提交**

```bash
git add src/ytdlp-manager/updater.ts src/ytdlp-manager/update.ts src/ytdlp-manager/updater.test.ts
git commit -m "feat(ytdlp-manager): add networked updateYtDlp + cron update entrypoint with proxy support"
```

---

### Task 5: 删除旧实现 + README + 全量验证

删除已被 service/updater 取代的旧 `ytDlpManager.ts` 及其测试,补充 README 的 cron 更新命令与首次初始化步骤,并对整个 ytdlp-manager 模块跑测试确认全绿。

**Files:**
- Delete: `src/ytdlp-manager/ytDlpManager.ts`
- Delete: `src/ytdlp-manager/ytDlpManager.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: 前四个任务产出的模块。
- Produces: 无新代码接口(清理 + 文档 + 验证)。

- [ ] **Step 1: 删除旧文件**

```bash
git rm src/ytdlp-manager/ytDlpManager.ts src/ytdlp-manager/ytDlpManager.test.ts
```

- [ ] **Step 2: 确认无残留引用(index.ts 除外,属已知超范围)**

Run: `bun test src/ytdlp-manager/`
Expected: PASS。toolDir / ytDlpService / runner / updater 四套测试全部通过,无对 `ytDlpManager.ts` 的引用报错。

> 说明:`src/index.ts` 仍引用旧 `ensureYtDlp` 与 `new YtDlpRunner()` 默认值,会导致**整仓**类型/构建失败——这是设计文档 Risks 已接受的已知项(用户后续重构调用方)。本计划验证以 **ytdlp-manager 模块自身测试**为准,不跑整仓 build。

- [ ] **Step 3: 补充 README(cron 更新命令 + 首次初始化)**

在 `README.md` 中新增一节(标题与措辞可按现有 README 风格微调,内容需包含以下命令):

```markdown
## yt-dlp 版本管理

yt-dlp 二进制由独立工具目录托管(默认 `/opt/yt-dlp`,Windows 默认 `C:\opt\yt-dlp`;可用环境变量 `YT_DLP_TOOL_DIR` 覆盖)。运行时通过 `YtDlpService` 解析 `current` 软链接获取二进制路径,不联网。

### 首次初始化 / 手动更新

首次使用需先运行一次更新任务下载二进制并建立 `current` 软链接:

    bun run src/ytdlp-manager/update.ts

如需经代理访问 GitHub:

    bun run src/ytdlp-manager/update.ts --proxy http://127.0.0.1:7890

### 定时更新(cron)

把上面的命令加入系统 crontab,例如每天 03:17 更新一次:

    17 3 * * * cd /path/to/tiktok-downloader && bun run src/ytdlp-manager/update.ts >> /var/log/yt-dlp-update.log 2>&1

更新成功切换 `current` 后仅保留最近两个版本;SHA256 校验失败或网络失败时不切换 `current` 并以非 0 状态码退出。
```

- [ ] **Step 4: 模块级全量验证**

Run: `bun test src/ytdlp-manager/`
Expected: PASS(toolDir 8 + ytDlpService 3 + runner 6 + updater 4 = 21 个测试全部通过)。

- [ ] **Step 5: 提交**

```bash
git add -A src/ytdlp-manager/ README.md
git commit -m "chore(ytdlp-manager): remove old ytDlpManager + document cron update workflow"
```

---

## 自审(Self-Review)

**1. Spec 覆盖检查:**

- 独立工具目录与 current 软链接(ytdlp-version-manager spec)→ Task 1(toolDir 路径/命名)+ Task 4(维护版本二进制与 current)。默认路径 + 环境变量覆盖 → Task 1 测试覆盖。
- 运行时 YtDlpService 解析二进制路径 → Task 2(current 可用返回路径、不联网、缺失/目标不存在报错)。
- 供 cron 调用的版本更新入口(获取 latest → 已最新不下载 → 下载 → SHA256 → chmod 0755 → 切 current;proxy 透传;可独立可执行)→ Task 4(updateYtDlp + update.ts)。
- 仅保留最近两个版本 → Task 4「只留两版」测试。
- 流式下载输出(stdout/stderr 可读流 + 退出码;proxy 透传给 yt-dlp `--proxy`;非 0 退出码暴露、不兜底)→ Task 3 `runStream` 测试(内容流出、退出码、参数透传含 `--proxy`)。
- MODIFIED「解析视频列表 / yt-dlp 二进制由 YtDlpService 提供」中「yt-dlp 二进制不可用 → 明确错误 + 非 0 退出」的**调用方装配**部分属 tasks.md 第 5 组,已按用户 SCOPE 显式排除;`YtDlpService` 抛明确错误的能力由 Task 2 提供,消费该错误的 index.ts 由用户后续重构。

**2. 占位符扫描:** 无 TBD/TODO;每个代码步骤均给出完整代码;测试均为可运行代码而非描述。

**3. 类型一致性:** `ProcessStream = { stdout: Readable; stderr: Readable; exited: Promise<number> }` 在 types.ts(Task 3)定义,runner.ts 实现一致;`YtDlpRunner` 构造函数在 Task 3 明确无默认值;`updateYtDlp`/`UpdateOptions`/`UpdateResult` 在 Task 4 定义并被 update.ts 消费,字段名一致;toolDir 四个函数名(`resolveToolDir`/`currentLinkPath`/`parseVersionFromTarget`/`versionBinName`)在 Task 1 定义,Task 2/4 引用一致。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-07-01-rewrite-ytdlp-version-manager.md`。两种执行方式:

1. **Subagent 驱动(推荐)** —— 每个任务派发全新 subagent,任务间评审,快速迭代。
2. **本会话内执行** —— 用 executing-plans 在当前会话按检查点批量执行。
