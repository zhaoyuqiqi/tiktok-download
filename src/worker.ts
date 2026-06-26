import type { DownloadResult, ProcessRunner, Task } from "./types.ts";

export async function download(
  runner: ProcessRunner,
  task: Task,
  outputDir: string,
  proxy?: string,
): Promise<DownloadResult> {
  const args = ["-P", outputDir, "--print", "after_move:filepath"];
  if (proxy !== undefined) {
    args.push("--proxy", proxy);
  }
  args.push(task.url);

  const result = await runner.run(args);

  if (result.code === 0) {
    const lines = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const filePath = lines[lines.length - 1];
    return { ok: true, filePath };
  }

  return { ok: false, error: result.stderr };
}
