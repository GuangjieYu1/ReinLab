import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { ApiFailure } from "../api/errors";
const deny = () =>
  new ApiFailure(
    "PAPERS_EGRESS_DENIED",
    403,
    "论文来源不在允许的公开网络范围。",
  );
/** One IPv4 address that no private, loopback or reserved range covers. */
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
/**
 * One globally routable address. IPv6 is accepted (global unicast only) because
 * the system resolver returns AAAA records ahead of A on IPv6-first networks.
 */
export function publicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return publicIPv4(address);
  if (version !== 6) return false;
  const folded = address.toLowerCase();
  const mapped = folded.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return publicIPv4(mapped[1]);
  // Loopback, unspecified, link-local, unique-local, multicast and IPv4-mapped
  // ranges are never a public paper source.
  if (folded === "::" || folded === "::1") return false;
  if (/^f[cd][0-9a-f]{2}:/.test(folded)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(folded)) return false;
  if (/^ff[0-9a-f]{2}:/.test(folded)) return false;
  if (folded.startsWith("2001:db8:")) return false;
  return true;
}
export type PaperReply = {
  status: number;
  headers: Record<string, string | undefined>;
  bytes: Buffer;
};
export type PaperAddress = { address: string; family: number };
export type PaperWire = (
  url: URL,
  address: PaperAddress,
  maximum: number,
  timeoutMs: number,
) => Promise<PaperReply>;
const wire: PaperWire = (url, target, maximum, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        family: target.family,
        headers: { accept: "application/json, application/pdf, application/atom+xml, application/xml, text/html" },
        lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        signal: AbortSignal.timeout(timeoutMs),
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
    req.on("error", (error) => {
      // 超时与连接失败都回可读原因，模型据此决定换源还是问用户。
      const timedOut = (error as NodeJS.ErrnoException).code === "ABORT_ERR";
      reject(
        new ApiFailure(
          timedOut ? "PAPERS_TIMEOUT" : "PAPERS_UNAVAILABLE",
          503,
          timedOut
            ? `论文来源在 ${Math.round(timeoutMs / 1000)} 秒内没有响应。`
            : `连不上论文来源：${String((error as Error).message ?? "").slice(0, 160)}`,
        ),
      );
    });
    req.end();
  });
/** DNS is pinned into the actual TLS request; redirects are checked independently. */
export class PaperHttp {
  constructor(
    private readonly options: {
      /** Test seam: a bare address string is read as its own family. */
      dns?: (host: string) => Promise<Array<string | PaperAddress>>;
      wire?: PaperWire;
      timeoutMs?: number;
    } = {},
  ) {
    if ((options.dns || options.wire) && process.env.NODE_ENV !== "test")
      throw new ApiFailure(
        "TEST_DEPENDENCY_FORBIDDEN",
        503,
        "测试网络不可用于生产论文获取。",
      );
  }
  /** The system resolver (`dns.lookup`) decides family and order, not us. */
  private async resolve(host: string): Promise<PaperAddress[]> {
    if (this.options.dns) {
      const found = await this.options.dns(host);
      return found.map((entry) =>
        typeof entry === "string"
          ? { address: entry, family: isIP(entry) || 4 }
          : entry,
      );
    }
    try {
      const found = await lookup(host, { all: true });
      return found.map((entry) => ({ address: entry.address, family: entry.family }));
    } catch (error) {
      throw new ApiFailure(
        "PAPERS_UNRESOLVABLE",
        503,
        `解析不出论文来源的地址：${String((error as Error).message ?? "").slice(0, 160)}`,
      );
    }
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
      // 不按来源域名设白名单（PRD 3.3）：公网论文来源和正常跳转都可以取。
      // 边界仍在环境层：必须是 https、不能带凭据，且解析出的每个地址都必须是
      // 公网地址——私网、回环、链路本地与保留段一律拒绝，跳转后的目标同样检查。
      // `allowed` 保留参数形状供调用方继续表达意图，但不再据此拒绝公网来源。
      void allowed;
      if (
        url.protocol !== "https:" ||
        (url.port && url.port !== "443") ||
        url.username ||
        url.password ||
        url.hash ||
        isIP(url.hostname)
      )
        throw deny();
      const addresses = await this.resolve(url.hostname);
      if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address)))
        throw deny();
      const response = await (this.options.wire ?? wire)(
        url,
        addresses[0],
        maximum,
        this.options.timeoutMs ?? 15_000,
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
