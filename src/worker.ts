import type { DownloadResult, ProcessRunner, Task } from "./types.ts";

export async function download(
  runner: ProcessRunner,
  task: Task,
  outputDir: string,
): Promise<DownloadResult> {
  const result = await runner.run([
    "-P",
    outputDir,
    "--print",
    "after_move:filepath",
    task.url,
  ]);

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
