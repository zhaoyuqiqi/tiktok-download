import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chdir, cwd } from "node:process";
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

  get ok(): boolean {
    return this.init.ok;
  }

  get status(): number {
    return this.init.status ?? 200;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.init.bodyText ?? "{}");
  }

  async text(): Promise<string> {
    if (this.init.bodyText !== undefined) {
      return this.init.bodyText;
    }
    return new TextDecoder().decode(this.init.bodyBytes ?? new Uint8Array());
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.init.bodyBytes !== undefined) {
      return toArrayBuffer(this.init.bodyBytes);
    }
    return toArrayBuffer(new TextEncoder().encode(this.init.bodyText ?? ""));
  }
}

interface FetchCall {
  url: string;
  proxy?: string;
}

function makeFetchMock(map: Record<string, MockResponseInit>, calls: FetchCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit & { proxy?: string }): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, proxy: init?.proxy });
    const hit = map[url];
    if (hit === undefined) {
      return new MockResponse({ ok: false, status: 404 }) as unknown as Response;
    }
    return new MockResponse(hit) as unknown as Response;
  }) as typeof fetch;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
      { name: "yt-dlp", browser_download_url: "https://example.com/yt-dlp" },
      { name: "yt-dlp.tar.gz", browser_download_url: "https://example.com/yt-dlp.tar.gz" },
      { name: "SHA2-256SUMS", browser_download_url: "https://example.com/SHA2-256SUMS" },
    ],
  });
}

async function createPatchAssets(root: string): Promise<{ patchTiktokPath: string; patchScriptPath: string }> {
  const patchTiktokPath = join(root, "tiktok.py");
  const patchScriptPath = join(root, "patch-yt-dlp.sh");
  await writeFile(patchTiktokPath, "# patched tiktok extractor\n");
  await writeFile(patchScriptPath, "#!/usr/bin/env sh\necho patched\n");
  await chmod(patchScriptPath, 0o755);
  return { patchTiktokPath, patchScriptPath };
}

function makeExtractMock(): (archivePath: string, targetDir: string) => Promise<void> {
  return async (_archivePath: string, targetDir: string): Promise<void> => {
    const extractedRoot = join(targetDir, "yt-dlp");
    await mkdir(join(extractedRoot, "yt_dlp", "extractor"), { recursive: true });
    await writeFile(join(extractedRoot, "yt_dlp", "extractor", "tiktok.py"), "# original\n");
  };
}

function shaSumsText(entries: Array<{ name: string; hash: string }>): string {
  return entries.map((entry) => `${entry.hash}  ${entry.name}`).join("\n") + "\n";
}

test("已是最新版本时不下载二进制，但仍准备 patched 源码并建立 current-src", async () => {
  const root = await tempToolDir();
  const version = "2026.06.28";
  const binaryName = `yt-dlp-${version}`;
  await writeFile(join(root, binaryName), "existing");
  await symlink(binaryName, join(root, "current"));

  const sourceArchive = new TextEncoder().encode("fake-source-archive");
  const sourceHash = await sha256Hex(sourceArchive);
  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody(version) },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([{ name: "yt-dlp.tar.gz", hash: sourceHash }]),
      },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
    },
    calls,
  );

  const patchAssets = await createPatchAssets(root);
  const result = await updateYtDlp({
    toolDir: root,
    platform: "darwin",
    fetchImpl: fetchMock,
    extractTarGzImpl: makeExtractMock(),
    patchTiktokSourcePath: patchAssets.patchTiktokPath,
    patchScriptSourcePath: patchAssets.patchScriptPath,
  });

  expect(result.updated).toBe(true);
  expect(result.localVersion).toBe(version);
  expect(await readlink(join(root, "current-src"))).toBe(`yt-dlp-src-${version}`);
  expect(calls.map((call) => call.url)).toEqual([
    API,
    "https://example.com/SHA2-256SUMS",
    "https://example.com/yt-dlp.tar.gz",
  ]);
});

test("有新版本时下载二进制+源码，校验 hash，注入 patch 并切换 current/current-src", async () => {
  const root = await tempToolDir();
  await writeFile(join(root, "yt-dlp-2026.06.10"), "old1");
  await writeFile(join(root, "yt-dlp-2026.06.20"), "old2");
  await mkdir(join(root, "yt-dlp-src-2026.06.20"), { recursive: true });
  await symlink("yt-dlp-2026.06.20", join(root, "current"));
  await symlink("yt-dlp-src-2026.06.20", join(root, "current-src"));

  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const sourceArchive = new TextEncoder().encode("dummy-yt-dlp-source");
  const binaryHash = await sha256Hex(binary);
  const sourceHash = await sha256Hex(sourceArchive);

  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([
          { name: "yt-dlp_macos", hash: binaryHash },
          { name: "yt-dlp.tar.gz", hash: sourceHash },
        ]),
      },
    },
    calls,
  );

  const patchAssets = await createPatchAssets(root);

  const result = await updateYtDlp({
    toolDir: root,
    platform: "darwin",
    fetchImpl: fetchMock,
    extractTarGzImpl: makeExtractMock(),
    patchTiktokSourcePath: patchAssets.patchTiktokPath,
    patchScriptSourcePath: patchAssets.patchScriptPath,
  });

  expect(result.updated).toBe(true);
  expect(await readlink(join(root, "current"))).toBe("yt-dlp-2026.06.28");
  expect(await readlink(join(root, "current-src"))).toBe("yt-dlp-src-2026.06.28");

  const names = (await readdir(root)).sort();
  expect(names).toContain("yt-dlp-2026.06.20");
  expect(names).toContain("yt-dlp-2026.06.28");
  expect(names).not.toContain("yt-dlp-2026.06.10");
  expect(names).toContain("yt-dlp-src-2026.06.20");
  expect(names).toContain("yt-dlp-src-2026.06.28");

  const binMode = (await stat(join(root, "yt-dlp-2026.06.28"))).mode & 0o777;
  const patchMode = (await stat(join(root, "yt-dlp-src-2026.06.28", "patch-yt-dlp.sh"))).mode & 0o777;
  expect(binMode).toBe(0o755);
  expect(patchMode).toBe(0o755);

  const patchedTiktokPy = await readFile(join(root, "yt-dlp-src-2026.06.28", "yt_dlp", "extractor", "tiktok.py"), "utf8");
  expect(patchedTiktokPy).toContain("patched tiktok extractor");

  expect(calls.map((call) => call.url)).toEqual([
    API,
    "https://example.com/SHA2-256SUMS",
    "https://example.com/yt-dlp_macos",
    "https://example.com/yt-dlp.tar.gz",
  ]);
});

test("二进制 SHA256 校验失败时报错且不切 current", async () => {
  const root = await tempToolDir();
  await writeFile(join(root, "yt-dlp-2026.06.20"), "old");
  await symlink("yt-dlp-2026.06.20", join(root, "current"));

  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const sourceArchive = new TextEncoder().encode("dummy-yt-dlp-source");
  const sourceHash = await sha256Hex(sourceArchive);

  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([
          { name: "yt-dlp_macos", hash: "0000000000000000000000000000000000000000000000000000000000000000" },
          { name: "yt-dlp.tar.gz", hash: sourceHash },
        ]),
      },
    },
    [],
  );

  const patchAssets = await createPatchAssets(root);

  await expect(
    updateYtDlp({
      toolDir: root,
      platform: "darwin",
      fetchImpl: fetchMock,
      extractTarGzImpl: makeExtractMock(),
      patchTiktokSourcePath: patchAssets.patchTiktokPath,
      patchScriptSourcePath: patchAssets.patchScriptPath,
    }),
  ).rejects.toThrow("SHA256 校验失败");
  expect(await readlink(join(root, "current"))).toBe("yt-dlp-2026.06.20");
});

test("proxy 透传给所有 fetch 调用", async () => {
  const root = await tempToolDir();
  const binary = new TextEncoder().encode("dummy-yt-dlp-binary");
  const sourceArchive = new TextEncoder().encode("dummy-yt-dlp-source");
  const binaryHash = await sha256Hex(binary);
  const sourceHash = await sha256Hex(sourceArchive);

  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([
          { name: "yt-dlp_macos", hash: binaryHash },
          { name: "yt-dlp.tar.gz", hash: sourceHash },
        ]),
      },
    },
    calls,
  );

  const patchAssets = await createPatchAssets(root);

  await updateYtDlp({
    toolDir: root,
    platform: "darwin",
    proxy: "http://127.0.0.1:7890",
    fetchImpl: fetchMock,
    extractTarGzImpl: makeExtractMock(),
    patchTiktokSourcePath: patchAssets.patchTiktokPath,
    patchScriptSourcePath: patchAssets.patchScriptPath,
  });

  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.proxy).toBe("http://127.0.0.1:7890");
  }
});

test("linux 平台应下载入口文件 yt-dlp", async () => {
  const root = await tempToolDir();
  const binary = new TextEncoder().encode("dummy-yt-dlp-entry");
  const sourceArchive = new TextEncoder().encode("dummy-yt-dlp-source");
  const binaryHash = await sha256Hex(binary);
  const sourceHash = await sha256Hex(sourceArchive);

  const calls: FetchCall[] = [];

  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp": { ok: true, bodyBytes: binary },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([
          { name: "yt-dlp", hash: binaryHash },
          { name: "yt-dlp.tar.gz", hash: sourceHash },
        ]),
      },
    },
    calls,
  );

  const patchAssets = await createPatchAssets(root);

  await updateYtDlp({
    toolDir: root,
    platform: "linux",
    fetchImpl: fetchMock,
    extractTarGzImpl: makeExtractMock(),
    patchTiktokSourcePath: patchAssets.patchTiktokPath,
    patchScriptSourcePath: patchAssets.patchScriptPath,
  });

  expect(calls.map((call) => call.url)).toContain("https://example.com/yt-dlp");
});

test("默认 patch 资产路径与 cwd 无关", async () => {
  const root = await tempToolDir();
  const binary = new TextEncoder().encode("dummy-yt-dlp-entry");
  const sourceArchive = new TextEncoder().encode("dummy-yt-dlp-source");
  const binaryHash = await sha256Hex(binary);
  const sourceHash = await sha256Hex(sourceArchive);

  const fetchMock = makeFetchMock(
    {
      [API]: { ok: true, bodyText: releaseBody("2026.06.28") },
      "https://example.com/yt-dlp_macos": { ok: true, bodyBytes: binary },
      "https://example.com/yt-dlp.tar.gz": { ok: true, bodyBytes: sourceArchive },
      "https://example.com/SHA2-256SUMS": {
        ok: true,
        bodyText: shaSumsText([
          { name: "yt-dlp_macos", hash: binaryHash },
          { name: "yt-dlp.tar.gz", hash: sourceHash },
        ]),
      },
    },
    [],
  );

  const originalCwd = cwd();
  const unrelatedDir = await tempToolDir();
  chdir(unrelatedDir);

  try {
    await updateYtDlp({
      toolDir: root,
      platform: "darwin",
      fetchImpl: fetchMock,
      extractTarGzImpl: makeExtractMock(),
    });
  } finally {
    chdir(originalCwd);
  }

  const patchedTiktokPy = await readFile(join(root, "yt-dlp-src-2026.06.28", "yt_dlp", "extractor", "tiktok.py"), "utf8");
  const patchedScript = await readFile(join(root, "yt-dlp-src-2026.06.28", "patch-yt-dlp.sh"), "utf8");
  expect(patchedTiktokPy).toContain("class TikTokBaseIE");
  expect(patchedScript).toContain("exec \"${PYTHON:-python3}\"");
});
