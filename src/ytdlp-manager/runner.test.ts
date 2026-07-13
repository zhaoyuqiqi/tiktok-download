import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { YtDlpRunner } from "./runner.ts";

let root = "";
let fakeBin = "";

const FAKE_SCRIPT = `#!/usr/bin/env bash
while [ "$1" = "-v" ]; do
  shift
done
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
  for a in "$@"; do printf '%s\n' "$a"; done
  exit 0
elif [ "$mode" = "generateok" ]; then
  printf '{"id":"v3","url":"https://example.com/v3"}\n'
  printf '{"title":"missing id"}\n'
  printf '{"id":"v2","url":"https://example.com/v2"}\n'
  exit 0
elif [ "$mode" = "generatefail" ]; then
  printf '{"id":"v1"}\n'
  printf 'list failed' 1>&2
  exit 5
fi
exit 42
`;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "yt-dlp-runner-"));
  fakeBin = join(root, "fake-yt-dlp.sh");
  await writeFile(fakeBin, FAKE_SCRIPT);
  await chmod(fakeBin, 0o755);
});

afterAll(async () => {
  if (root !== "") {
    await rm(root, { recursive: true, force: true });
  }
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
  expect(result.stdout.split("\n").filter((line) => line !== "")).toEqual([
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
  expect(stdout.split("\n").filter((line) => line !== "")).toEqual([
    "--proxy",
    "http://127.0.0.1:7890",
  ]);
});

test("generateRun 逐行解析列表并跳过缺少 id 的条目", async () => {
  const runner = new YtDlpRunner(fakeBin);
  const checkedIds: string[] = [];
  const entries = await runner.generateRun(["generateok"], (postId) => {
    checkedIds.push(postId);
    return false;
  });

  expect(checkedIds).toEqual(["v3", "v2"]);
  expect(entries.map((entry) => entry.id)).toEqual(["v3", "v2"]);
});

test("generateRun 非 0 退出码会抛出 stderr", async () => {
  const runner = new YtDlpRunner(fakeBin);

  await expect(runner.generateRun(["generatefail"], () => false)).rejects.toThrow("list failed");
});
