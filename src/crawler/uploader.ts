import fakeua from "fake-useragent";
import COS from "cos-nodejs-sdk-v5";

interface CosPutObjectInput {
  Key: string;
  FilePath?: string;
  Body?: NodeJS.ReadableStream;
}
interface StsCredentials {
  data: {
    credentials: {
      tmpSecretId: string;
      tmpSecretKey: string;
      sessionToken: string;
    };
    startTime: number;
    expiredTime: number;
    cdnhost?: string;
    bucket?: string;
  };
  errNo: number;
}

type RequestInitWithProxy = RequestInit & { proxy?: string };

function withProxy(
  proxy: string | undefined,
  init: RequestInit = {},
): RequestInitWithProxy {
  if (!proxy) {
    return init as RequestInitWithProxy;
  }
  return { ...init, proxy } as RequestInitWithProxy;
}

export class CosUploader {
  private cosClient: COS;

  constructor() {
    this.cosClient = new COS({
      getAuthorization: async (_, callback) => {
        const res = await this.getAuthorization();
        if (res === undefined) {
          throw new Error("获取 COS STS 失败");
        }
        callback(res);
      },
    });
  }

  putObject(params: CosPutObjectInput) {
    const Bucket = process.env.BUCKET;
    const Region = process.env.REGION?.trim() || "ap-beijing";
    if (!Bucket) {
      throw new Error("Bucket不存在或配置错误");
    }
    if (!params.Body && !params.FilePath) {
      throw new Error("上传文件不存在或配置错误");
    }
    if (params.Body) {
      return this.cosClient.putObject({
        Key: params.Key,
        Body: params.Body,
        Bucket,
        Region,
      });
    }
    return this.cosClient.uploadFile({
      Bucket,
      Region,
      Key: params.Key,
      FilePath: params.FilePath!,
      SliceSize: 1024 * 1024 * 5, // 触发分块上传的阈值，超过5MB使用分块上传，非必须
      onProgress({ percent, speed, loaded, total }) {
        console.log(
          "上传进度",
          percent * 100 + "%",
          "speed",
          speed,
          "total",
          total,
          "loaded",
          loaded,
        );
      },
    });
  }

  private async requestSts(
    url: string,
    headers: Record<string, string>,
  ): Promise<StsCredentials> {
    try {
      const response = await fetch(
        url,
        withProxy(undefined, {
          headers,
        }),
      );
      if (response.ok) {
        return (await response.json()) as StsCredentials;
      }
      throw new Error("使用代理请求cossts失败");
    } catch (error) {}
    try {
      const res2 = await fetch(url, {
        headers,
      });
      if (res2.ok) {
        return (await res2.json()) as StsCredentials;
      }
      throw new Error("不使用代理请求cossts失败");
    } catch (error) {}
    return {
      data: {
        credentials: {
          tmpSecretId: "",
          tmpSecretKey: "",
          sessionToken: "",
        },
        startTime: 0,
        expiredTime: 0,
        cdnhost: undefined,
        bucket: undefined,
      },
      errNo: 0,
    } satisfies StsCredentials;
  }

  private async getAuthorization() {
    const authUrl1 =
      "https://www.fengniaojianzhan.com/fengniao/common/getcossts";

    const actId = `7${String(Math.random() * 1000000000)
      .replace(".", "")
      .slice(0, 9)}${String(Math.random() * 1000000000)
      .replace(".", "")
      .slice(0, 9)}`;

    const headers = {
      "Content-Type": "application/json",
      "User-Agent": fakeua(),
      Referer: `https://www.fengniaojianzhan.com/fengniao/p/${actId}?actId=${actId}&groupId=0&enforceWK=1&fxRCode=&lastfrom=&referralPostId=6901&flowPond=%257B%2522actId%2522%253A%25227313035368425459876%2522%252C%2522groupId%2522%253A%25222%2522%252C%2522orifacId%2522%253A%25227313035368425459876%2522%252C%2522fcid%2522%253A%25227313035368425459876%2522%252C%2522queryPosterType%2522%253A%2522normal%2522%252C%2522posterCurrentId%2522%253A%25220%2522%252C%2522referralPostId%2522%253A6901%257D&bizType=2`,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      DNT: "1",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-site",
    };

    const res = await this.requestSts(authUrl1, {
      ...headers,
      Origin: new URL(authUrl1).origin,
    });

    if (res.errNo !== 0) {
      return undefined;
    }

    return {
      TmpSecretId: res.data.credentials.tmpSecretId,
      TmpSecretKey: res.data.credentials.tmpSecretKey,
      XCosSecurityToken: res.data.credentials.sessionToken,
      StartTime: res.data.startTime,
      ExpiredTime: res.data.expiredTime,
      ScopeLimit: true,
    };
  }
}

export const uploader = new CosUploader();

// process.env.BUCKET = 'zyb-fengniao-1253445850'
// // 获取当前文件绝对路径
// const __filename = fileURLToPath(import.meta.url);
// // 获取当前文件所在目录
// const __dirname = path.dirname(__filename);
// await uploader.putObject({
//   Key: 'fengniao/fengniao_9bf55a91-667f-48f5-b6ac-a2a31922468c78.mov',
//   FilePath: path.join(__dirname,'./fengniao_9bf55a91-667f-48f5-b6ac-a2a31922468c78.mov')
// })
