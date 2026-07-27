export function isImagePost(rawDetail: Record<string, unknown> | undefined): boolean {
  return rawDetail?.video_ext === "none";
}
