import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
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
  globalThis.fetch = ((async () => {
    fetchCalled = true;
    throw new Error("不应联网");
  }) as unknown) as typeof fetch;

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

test("current-src 可用时返回 patch-yt-dlp.sh 绝对路径", async () => {
  const root = await tempToolDir();
  const srcDirName = "yt-dlp-src-2026.06.28";
  const srcDir = join(root, srcDirName);
  await mkdir(srcDir, { recursive: true });
  await writeFile(join(srcDir, "patch-yt-dlp.sh"), "#!/usr/bin/env sh\necho ok\n");
  await symlink(srcDirName, join(root, "current-src"));

  const service = new YtDlpService({ toolDir: root });
  const path = await service.getPatchedProfileRunnerPath();
  expect(path).toBe(join(srcDir, "patch-yt-dlp.sh"));
});

test("current-src 缺失时抛明确错误", async () => {
  const root = await tempToolDir();
  const service = new YtDlpService({ toolDir: root });
  await expect(service.getPatchedProfileRunnerPath()).rejects.toThrow(/current-src/);
});

test("current-src 指向目录存在但 patch 脚本缺失时抛错", async () => {
  const root = await tempToolDir();
  const srcDirName = "yt-dlp-src-2026.06.28";
  const srcDir = join(root, srcDirName);
  await mkdir(srcDir, { recursive: true });
  await symlink(srcDirName, join(root, "current-src"));

  const service = new YtDlpService({ toolDir: root });
  await expect(service.getPatchedProfileRunnerPath()).rejects.toThrow(/patch 脚本/);
});
