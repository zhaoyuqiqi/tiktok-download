
import Cos from "cos-nodejs-sdk-v5";
import { spawn } from "child_process";
import { PassThrough } from "stream";

const proc = spawn("/Users/zyb/Library/Application Support/tiktok-downloader/yt-dlp/current", [
  "--proxy",
  "http://127.0.0.1:2080",
  "-o",
  "-",
  "https://www.tiktok.com/@yua_mikami/video/7657054518634351880",
]);
proc.stdout.on("data", (data) => {
  console.log(data.toString());
});
const cos = new Cos({});

const passThrough = new PassThrough();

const result = await cos.putObject(
  {
    Bucket: "examplebucket-1250000000", // 填入您自己的存储桶，必须字段
    Region: "COS_REGION", // 存储桶所在地域，例如 ap-beijing，必须字段
    Key: "", // 必须
    Body: proc.stdout.pipe(passThrough), // 只传正文的流
  },
);
