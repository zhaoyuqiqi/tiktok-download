import fakeua from "fake-useragent";
import COS from "cos-nodejs-sdk-v5";
import { loadServiceConfig } from "../config.ts";
import type { CosPutObjectInput } from "./cosStreamUpload.ts";

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

const envConfig = loadServiceConfig();

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
    return this.cosClient.putObject({
      Key: params.Key,
      Body: params.Body,
      Bucket: params.Bucket,
      Region: params.Region,
    });
  }

  private async requestSts(
    url: string,
    headers: Record<string, string>,
  ): Promise<StsCredentials> {
    const response = await fetch(
      url,
      withProxy(envConfig.proxy, {
        headers,
      }),
    );

    return (await response.json()) as StsCredentials;
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
