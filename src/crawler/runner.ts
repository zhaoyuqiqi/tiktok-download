import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type {
  PostListItem,
  ProcessResult,
  ProcessStream,
} from "./types/yt-dlp";
import { sleep } from "bun";
import { sleepRandom2000To8000 } from "./utils/sleep";

export class Runner {
  constructor(private binPath: string) {}
  async run(args: string[]): Promise<ProcessResult> {
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    const code = await new Promise<number>((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
    });

    return {
      code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    };
  }

  async generateRun(
    args: string[],
    isExists: (postId: string) => Promise<boolean>,
  ) {
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const rl = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    const closePromise = this.close(child);
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(Buffer.from(chunk));
    });

    const data: PostListItem[] = [];
    let stoppedAtFetchedPost = false;
    try {
      for await (const line of rl) {
        if (!line.trim()) {
          continue;
        }

        let postData;

        try {
          postData = JSON.parse(line) as PostListItem;
        } catch {
          continue;
        }
        const postId =
          typeof postData.id === "string" ? postData.id.trim() : "";
        if (postId.length === 0) {
          continue;
        }
        const fetchedPost = await isExists(postId);
        if (fetchedPost) {
          stoppedAtFetchedPost = true;
          child.kill("SIGTERM");
          break;
        }
        data.push({ ...postData, id: postId });
      }

      const closeResult = await Promise.race([closePromise, sleep(3000)]);

      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      if (
        typeof closeResult === "number" &&
        closeResult !== 0 &&
        !stoppedAtFetchedPost
      ) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        throw new Error(
          stderr || `yt-dlp 列表抓取失败，退出码: ${closeResult}`,
        );
      }
      return data;
    } finally {
      rl.close();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }
  }

  private close(child: ChildProcess) {
    return new Promise<number>((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
    });
  }

  async runStream(args: string[]): Promise<ProcessStream> {
    const child = spawn(this.binPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await sleepRandom2000To8000();
    const exited = new Promise<number>((resolvePromise, rejectPromise) => {
      child.on("error", rejectPromise);
      child.on("close", (exitCode) => resolvePromise(exitCode ?? 0));
    });
    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
    };
  }
}
