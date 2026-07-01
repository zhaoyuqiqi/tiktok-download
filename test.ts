import { createWriteStream } from "fs";
import { spawn } from "child_process";

const proc = spawn("yt-dlp", [
  // "-J",
  "--proxy",
  "http://127.0.0.1:2080",
  "-o",
  "-",
  "https://www.tiktok.com/@yua_mikami/video/7657054518634351880",
]);

// 创建文件写入流
const writeStream = createWriteStream("a555555555555555.mp4");

// 管道：stdout 直接进文件
proc.stdout.pipe(writeStream);

// 监听错误
proc.stderr.on("data", (data) => {
  console.log(data.toString());
});

proc.on("error", (e) => {
  console.log(e);
});
