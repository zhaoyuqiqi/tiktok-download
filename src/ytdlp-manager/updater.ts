import {
  access,
  chmod,
  copyFile,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  currentLinkPath,
  currentSourceLinkPath,
  parseVersionFromTarget,
  resolveToolDir,
  versionBinName,
  versionSourceDirName,
} from "./toolDir.ts";
import { toBool } from "../logging/debugLogger.ts";

const LATEST_RELEASE_API = "https://api.github.19981105.xyz/repos/yt-dlp/yt-dlp/releases/latest";
const SOURCE_ARCHIVE_ASSET = "yt-dlp.tar.gz";

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
  patchTiktokSourcePath?: string;
  patchScriptSourcePath?: string;
  extractTarGzImpl?: (archivePath: string, targetDir: string) => Promise<void>;
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

async function switchCurrentSourceSymlink(toolDir: string, targetName: string): Promise<void> {
  const linkPath = currentSourceLinkPath(toolDir);
  await safeUnlink(linkPath);
  await symlink(targetName, linkPath);
}

async function cleanupOldVersions(toolDir: string): Promise<void> {
  const names = await readdir(toolDir);
  const versions = names.filter((name) => name.startsWith("yt-dlp-") && !name.startsWith("yt-dlp-src-"));
  versions.sort((left, right) => right.localeCompare(left));
  await Promise.all(versions.slice(2).map((name) => safeUnlink(join(toolDir, name))));
}

async function cleanupOldSourceVersions(toolDir: string): Promise<void> {
  const names = await readdir(toolDir);
  const versions = names.filter((name) => name.startsWith("yt-dlp-src-"));
  versions.sort((left, right) => right.localeCompare(left));
  await Promise.all(
    versions.slice(2).map((name) => rm(join(toolDir, name), { recursive: true, force: true })),
  );
}

function findChecksumAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => /sha2[-_]?256sums/i.test(asset.name));
}

function findSourceArchiveAsset(assets: ReleaseAsset[]): ReleaseAsset | undefined {
  return assets.find((asset) => asset.name === SOURCE_ARCHIVE_ASSET);
}

function withProxy(proxy: string | undefined, init: RequestInit = {}): RequestInit & { proxy?: string; verbose?: boolean} {
  if (proxy === undefined || proxy === "") {
    return init as RequestInit & { proxy?: string };
  }
  return { ...init, proxy, verbose: toBool(process.env.APP_DEBUG) } as RequestInit & { proxy?: string };
}

async function extractTarGzWithSystemTar(archivePath: string, targetDir: string): Promise<void> {
  const code = await new Promise<number>((resolvePromise, rejectPromise) => {
    const child = spawn("tar", ["-xzf", archivePath, "-C", targetDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", rejectPromise);
    child.on("close", (exitCode) => {
      if ((exitCode ?? 0) !== 0) {
        rejectPromise(new Error(`解压 ${SOURCE_ARCHIVE_ASSET} 失败: ${stderr.trim() || `exit=${exitCode}`}`));
        return;
      }
      resolvePromise(exitCode ?? 0);
    });
  });

  if (code !== 0) {
    throw new Error(`解压 ${SOURCE_ARCHIVE_ASSET} 失败: exit=${code}`);
  }
}

async function resolveExtractedRoot(extractDir: string): Promise<string> {
  const names = await readdir(extractDir);
  if (names.length === 0) {
    throw new Error(`解压 ${SOURCE_ARCHIVE_ASSET} 后目录为空`);
  }

  if (names.length === 1) {
    return join(extractDir, names[0]!);
  }

  if (names.includes("yt_dlp")) {
    return extractDir;
  }

  const preferred = names.find((name) => name.startsWith("yt-dlp"));
  if (preferred !== undefined) {
    return join(extractDir, preferred);
  }

  return join(extractDir, names[0]!);
}

function assertAssetHash(checksumMap: Map<string, string>, name: string): string {
  const expectedHash = checksumMap.get(name);
  if (expectedHash === undefined) {
    throw new Error(`SHA256 校验文件中缺少 ${name} 的摘要`);
  }
  return expectedHash;
}

function resolveBundledAssetPath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function defaultPatchTiktokPath(): string {
  return resolveBundledAssetPath("../../docker/tiktok.py");
}

function defaultPatchScriptPath(): string {
  return resolveBundledAssetPath("../../docker/patch-yt-dlp.sh");
}

async function injectPatchAssets(opts: {
  sourceDirPath: string;
  patchTiktokSourcePath: string;
  patchScriptSourcePath: string;
}): Promise<void> {
  const extractorDir = join(opts.sourceDirPath, "yt_dlp", "extractor");
  const targetTiktokPath = join(extractorDir, "tiktok.py");
  const targetScriptPath = join(opts.sourceDirPath, "patch-yt-dlp.sh");

  await mkdir(extractorDir, { recursive: true });
  await copyFile(opts.patchTiktokSourcePath, targetTiktokPath);
  await copyFile(opts.patchScriptSourcePath, targetScriptPath);
  await chmod(targetScriptPath, 0o755);
}

export async function updateYtDlp(opts: UpdateOptions = {}): Promise<UpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const platform = opts.platform ?? process.platform;
  const toolDir = resolveToolDir(opts.toolDir);

  await mkdir(toolDir, { recursive: true });

  const localVersion = await readCurrentVersion(toolDir);

  const releaseResp = await fetchImpl(
    LATEST_RELEASE_API,
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
  const sourceDirName = versionSourceDirName(latestVersion);
  const sourceDirPath = join(toolDir, sourceDirName);

  const hasBinary = await fileExists(latestPath);
  const hasSource = await fileExists(sourceDirPath);

  if (hasBinary && localVersion !== latestVersion) {
    await switchCurrentSymlink(toolDir, latestName);
  }

  const checksumAsset = findChecksumAsset(data.assets as ReleaseAsset[]);
  if (checksumAsset === undefined) {
    throw new Error("未在 release 资产中找到 SHA256 校验文件");
  }

  const needBinaryDownload = !hasBinary;
  const needSourceDownload = !hasSource;

  let checksumMap = new Map<string, string>();
  if (needBinaryDownload || needSourceDownload) {
    const useProxy = checksumAsset.browser_download_url.includes('github.com')
    const checksumResp = await fetchImpl(checksumAsset.browser_download_url,useProxy ? withProxy(opts.proxy): {});
    if (!checksumResp.ok) {
      throw new Error(`下载 SHA256 校验文件失败: HTTP ${checksumResp.status}`);
    }

    const checksumText = await checksumResp.text();
    checksumMap = parseChecksumMap(checksumText);
  }

  if (needBinaryDownload) {
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
    const useProxy = binaryAsset.browser_download_url.includes('github.com')
    const binaryResp = await fetchImpl(binaryAsset.browser_download_url, useProxy ? withProxy(opts.proxy): {});
    if (!binaryResp.ok) {
      throw new Error(`下载 yt-dlp 二进制失败: HTTP ${binaryResp.status}`);
    }

    const binaryBytes = new Uint8Array(await binaryResp.arrayBuffer());
    const expectedHash = assertAssetHash(checksumMap, assetName);
    const actualHash = await sha256Hex(binaryBytes);
    if (actualHash !== expectedHash) {
      throw new Error(`SHA256 校验失败: expected=${expectedHash}, actual=${actualHash}`);
    }

    await writeFile(latestPath, binaryBytes);
    await chmod(latestPath, 0o755);
    await switchCurrentSymlink(toolDir, latestName);
  }

  if (needSourceDownload) {
    const sourceAsset = findSourceArchiveAsset(data.assets as ReleaseAsset[]);
    if (sourceAsset === undefined) {
      throw new Error(`未在 release 资产中找到源码归档: ${SOURCE_ARCHIVE_ASSET}`);
    }
    const useProxy = sourceAsset.browser_download_url.includes('github.com')
    const sourceResp = await fetchImpl(sourceAsset.browser_download_url, useProxy ? withProxy(opts.proxy) : {});
    if (!sourceResp.ok) {
      throw new Error(`下载 ${SOURCE_ARCHIVE_ASSET} 失败: HTTP ${sourceResp.status}`);
    }

    const sourceBytes = new Uint8Array(await sourceResp.arrayBuffer());
    const expectedHash = assertAssetHash(checksumMap, SOURCE_ARCHIVE_ASSET);
    const actualHash = await sha256Hex(sourceBytes);
    if (actualHash !== expectedHash) {
      throw new Error(`${SOURCE_ARCHIVE_ASSET} SHA256 校验失败: expected=${expectedHash}, actual=${actualHash}`);
    }

    const stagingDir = join(toolDir, `.source-${latestVersion}.staging`);
    const archivePath = join(stagingDir, SOURCE_ARCHIVE_ASSET);
    const extractDir = join(stagingDir, "extract");

    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await writeFile(archivePath, sourceBytes);

    const extractImpl = opts.extractTarGzImpl ?? extractTarGzWithSystemTar;
    await extractImpl(archivePath, extractDir);

    const extractedRoot = await resolveExtractedRoot(extractDir);
    await rm(sourceDirPath, { recursive: true, force: true });
    await rename(extractedRoot, sourceDirPath);
    await rm(stagingDir, { recursive: true, force: true });
  }

  const patchTiktokSourcePath = opts.patchTiktokSourcePath ?? defaultPatchTiktokPath();
  const patchScriptSourcePath = opts.patchScriptSourcePath ?? defaultPatchScriptPath();

  if (!(await fileExists(patchTiktokSourcePath))) {
    throw new Error(`未找到 patched tiktok.py: ${patchTiktokSourcePath}`);
  }
  if (!(await fileExists(patchScriptSourcePath))) {
    throw new Error(`未找到 patch-yt-dlp.sh: ${patchScriptSourcePath}`);
  }

  await injectPatchAssets({
    sourceDirPath,
    patchTiktokSourcePath,
    patchScriptSourcePath,
  });

  await switchCurrentSourceSymlink(toolDir, sourceDirName);
  await cleanupOldVersions(toolDir);
  await cleanupOldSourceVersions(toolDir);

  return { updated: needBinaryDownload || needSourceDownload, latestVersion, localVersion };
}
