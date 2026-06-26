import type { ProcessResult, ProcessRunner } from "./types.ts";

export class YtDlpRunner implements ProcessRunner {
  constructor(private readonly binPath: string = "yt-dlp") {}

  async run(args: string[]): Promise<ProcessResult> {
    const proc = Bun.spawn([this.binPath, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }
}

export function checkYtDlpAvailable(): boolean {
  return Bun.which("yt-dlp") !== null;
}
