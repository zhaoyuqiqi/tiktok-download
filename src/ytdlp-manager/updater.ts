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
    case "linux":
      return "yt-dlp";
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
    if (trimmed === "") {
      continue;
    }

    const match = trimmed.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match === null) {
      continue;
    }

    const hash = match[1]?.toLowerCase();
    const name = match[2]?.trim();
    if (hash !== undefined && name !== undefined && name !== "") {
      map.set(name, hash);
    }
  }
  return map;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(data).buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function switchCurrentSymlink(toolDir: string, targetName: string): Promise<void> {
  const linkPath = currentLinkPath(toolDir);
  await safeUnlink(linkPath);
  await symlink(targetName, linkPath);
}

async function cleanupOldVersions(toolDir: string): Promise<void> {
  const names = await readdir(toolDir);
  const versions = names.filter((name) => name.startsWith("yt-dlp-"));
  versions.sort((left, right) => right.localeCompare(left));
  await Promise.all(versions.slice(2).map((name) => safeUnlink(join(toolDir, name))));
}

function findChecksumAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => /sha2[-_]?256sums/i.test(asset.name));
}

function withProxy(proxy: string | undefined, init: RequestInit = {}): RequestInit & { proxy?: string } {
  if (proxy === undefined || proxy === "") {
    return init as RequestInit & { proxy?: string };
  }
  return { ...init, proxy } as RequestInit & { proxy?: string };
}

export async function updateYtDlp(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const toolDir = resolveToolDir(opts.toolDir);

  await mkdir(toolDir, { recursive: true });

  const localVersion = await readCurrentVersion(toolDir);
  
  const releaseResp = await fetchImpl(
    LATEST_RELEASE_API,
    withProxy(opts.proxy, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "tiktok-downloader",
      },
    }),
  );  
  if (!releaseResp.ok) {
    throw new Error(`获取 yt-dlp 最新版本失败: HTTP ${releaseResp.status}`);
  }

  const data = (await releaseResp.json()) as Partial<ReleaseResponse>;
  if (typeof data.tag_name !== "string" || !Array.isArray(data.assets)) {
    throw new Error("GitHub Release 响应缺少必要字段(tag_name/assets)");
  }

  const latestVersion = data.tag_name;
  const latestName = versionBinName(latestVersion);
  const latestPath = join(toolDir, latestName);
  if (await fileExists(latestPath)) {
    if (localVersion !== latestVersion) {
      await switchCurrentSymlink(toolDir, latestName);
    }
    return { updated: false, latestVersion, localVersion };
  }

  const assetName = pickAssetName(platform);
  const binaryAsset = data.assets.find((asset): asset is ReleaseAsset => {
    return (
      typeof asset === "object" &&
      asset !== null &&
      "name" in asset &&
      "browser_download_url" in asset &&
      asset.name === assetName
    );
  });
  if (binaryAsset === undefined) {
    throw new Error(`未在 release 资产中找到平台二进制: ${assetName}`);
  }

  const checksumAsset = findChecksumAsset(data.assets as ReleaseAsset[]);
  if (checksumAsset === undefined) {
    throw new Error("未在 release 资产中找到 SHA256 校验文件");
  }

  const [binaryResp, checksumResp] = await Promise.all([
    fetchImpl(binaryAsset.browser_download_url, withProxy(opts.proxy)),
    fetchImpl(checksumAsset.browser_download_url, withProxy(opts.proxy)),
  ]);
  if (!binaryResp.ok) {
    throw new Error(`下载 yt-dlp 二进制失败: HTTP ${binaryResp.status}`);
  }
  if (!checksumResp.ok) {
    throw new Error(`下载 SHA256 校验文件失败: HTTP ${checksumResp.status}`);
  }
  
  const [binaryBuffer, checksumText] = await Promise.all([binaryResp.arrayBuffer(), checksumResp.text()]);
  const expectedHash = parseChecksumMap(checksumText).get(assetName);
  if (expectedHash === undefined) {
    throw new Error(`SHA256 校验文件中缺少 ${assetName} 的摘要`);
  }

  const binaryBytes = new Uint8Array(binaryBuffer);
  const actualHash = await sha256Hex(binaryBytes);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA256 校验失败: expected=${expectedHash}, actual=${actualHash}`);
  }

  await writeFile(latestPath, binaryBytes);
  await chmod(latestPath, 0o755);
  await switchCurrentSymlink(toolDir, latestName);
  await cleanupOldVersions(toolDir);

  return { updated: true, latestVersion, localVersion };
}
