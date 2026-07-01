import { updateYtDlp } from "./updater.ts";

function parseProxy(argv: string[]): string | undefined {
  const index = argv.indexOf("--proxy");
  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];
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
    return;
  }

  console.log(`yt-dlp 已是最新版本 ${result.latestVersion},无需更新`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
