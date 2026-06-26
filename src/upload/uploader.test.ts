import { test, expect } from "bun:test";
import { NoopUploader } from "./uploader.ts";

test("NoopUploader.upload 不抛错且 resolve", async () => {
  const u = new NoopUploader();
  await expect(u.upload("/tmp/x.mp4")).resolves.toBeUndefined();
});
