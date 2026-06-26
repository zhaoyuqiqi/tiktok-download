import type { ProcessRunner, VideoInfo } from "./types.ts";

interface RawEntry {
  id?: string;
  url?: string;
  webpage_url?: string;
  title?: string;
}

interface RawJson extends RawEntry {
  _type?: string;
  entries?: RawEntry[];
}

export async function parse(
  runner: ProcessRunner,
  url: string,
  limit?: number,
): Promise<VideoInfo[]> {
  const args = ["-J", "--flat-playlist"];
  if (limit !== undefined) {
    args.push("-I", `:${limit}`);
  }
  args.push(url);

  const result = await runner.run(args);

  let data: RawJson;
  try {
    data = JSON.parse(result.stdout) as RawJson;
  } catch {
    throw new Error(`无法解析 yt-dlp 输出: ${result.stderr || result.stdout}`);
  }

  if (Array.isArray(data.entries)) {
    const videos = data.entries.map((e): VideoInfo => {
      const id = e.id ?? "";
      return { id, url: e.url ?? id, title: e.title };
    });
    if (videos.length === 0) {
      throw new Error("未解析到任何视频条目");
    }
    return videos;
  }

  const id = data.id ?? "";
  if (id === "") {
    throw new Error("未解析到任何视频条目");
  }
  return [{ id, url: data.webpage_url ?? data.url ?? url, title: data.title }];
}
