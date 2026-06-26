import type { Uploader } from "../types.ts";

export class NoopUploader implements Uploader {
  async upload(_filePath: string): Promise<void> {
    // 占位:后续替换为真实对象存储上传(上传后自行删除视频)
  }
}
