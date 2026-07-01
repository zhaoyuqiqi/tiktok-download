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
  expect(calls.map((call) => call.url)).toEqual([API]);
});

test("已有最新版本文件但缺少 current 时重建软链接且不下载", async () => {
  const root = await tempToolDir();
  const version = "2026.06.28";
  await writeFile(join(root, `yt-dlp-${version}`), "existing");

  const calls: FetchCall[] = [];
  const fetchMock = makeFetchMock({ [API]: { ok: true, bodyText: releaseBody(version) } }, calls);

  const result = await updateYtDlp({ toolDir: root, platform: "darwin", fetchImpl: fetchMock });
  expect(result.updated).toBe(false);
  expect(result.localVersion).toBeUndefined();
  expect(await readlink(join(root, "current"))).toBe(`yt-dlp-${version}`);
  expect(calls.map((call) => call.url)).toEqual([API]);
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
        bodyText: "0000000000000000000000000000000000000000000000000000000000000000  yt-dlp_macos\n",
      },
    },
    [],
  );

  await expect(updateYtDlp({ toolDir: root, platform: "darwin", fetchImpl: fetchMock })).rejects.toThrow(
    "SHA256 校验失败",
  );
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

  await updateYtDlp({
    toolDir: root,
    platform: "darwin",
    proxy: "http://127.0.0.1:7890",
    fetchImpl: fetchMock,
  });
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.proxy).toBe("http://127.0.0.1:7890");
  }
});
