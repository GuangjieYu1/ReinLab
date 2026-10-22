import { resolve4 } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { ApiFailure } from "../api/errors";
const deny = () =>
  new ApiFailure(
    "PAPERS_EGRESS_DENIED",
    403,
    "论文来源不在允许的公开网络范围。",
  );
export function publicIPv4(address: string) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split(".").map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    a < 224 &&
    !(a === 100 && b >= 64 && b <= 127) &&
    !(a === 169 && b === 254) &&
    !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && (b === 168 || b === 0 || b === 2)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113)
  );
}
export type PaperReply = {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: Buffer;
};
export type PaperWire = (
  url: URL,
  address: string,
  maximum: number,
) => Promise<PaperReply>;
const wire: PaperWire = (url, address, maximum) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        family: 4,
        headers: { accept: "application/json, application/pdf" },
        lookup: (_hostname, _options, callback) => callback(null, address, 4),
        timeout: 10000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (part: Buffer) => {
          size += part.length;
          if (size > maximum) {
            res.destroy();
            req.destroy();
            reject(
              new ApiFailure(
                "PAPER_TOO_LARGE",
                413,
                "论文来源响应超过大小限制。",
              ),
            );
          } else chunks.push(part);
        });
        res.on("error", () =>
          reject(
            new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文来源暂不可用。"),
          ),
        );
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 500,
            headers: {
              location:
                typeof res.headers.location === "string"
                  ? res.headers.location
                  : undefined,
              contentType:
                typeof res.headers["content-type"] === "string"
                  ? res.headers["content-type"]
                  : undefined,
            },
            bytes: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () =>
      reject(new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文来源暂不可用。")),
    );
    req.end();
  });
/** DNS is pinned into the actual TLS request; redirects are checked independently. */
export class PaperHttp {
  constructor(
    private readonly options: {
      dns?: (host: string) => Promise<string[]>;
      wire?: PaperWire;
    } = {},
  ) {
    if ((options.dns || options.wire) && process.env.NODE_ENV !== "test")
      throw new ApiFailure(
        "TEST_DEPENDENCY_FORBIDDEN",
        503,
        "测试网络不可用于生产论文获取。",
      );
  }
  async get(
    raw: string,
    allowed: string[],
    maximum: number,
  ): Promise<PaperReply> {
    let value = raw;
    for (let hop = 0; hop < 4; hop++) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw deny();
      }
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        url.hash ||
        !allowed.includes(url.hostname) ||
        isIP(url.hostname)
      )
        throw deny();
      const addresses = await (this.options.dns ?? resolve4)(url.hostname);
      if (!addresses.length || addresses.some((a) => !publicIPv4(a)))
        throw deny();
      const response = await (this.options.wire ?? wire)(
        url,
        addresses[0],
        maximum,
      );
      if (response.bytes.length > maximum)
        throw new ApiFailure(
          "PAPER_TOO_LARGE",
          413,
          "论文来源响应超过大小限制。",
        );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw deny();
        value = new URL(response.headers.location, url).href;
        continue;
      }
      return response;
    }
    throw deny();
  }
}
