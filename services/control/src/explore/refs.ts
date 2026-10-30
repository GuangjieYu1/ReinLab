/**
 * 档案参考图（06 §6、07 契约第 1、2、3 节）。
 *
 * 图片由服务端存一份副本，供页面和 PDF 稳定读取；副本只在这份档案的
 * 登录会话里能读到，不公开。保存原网页、作者/平台与来源时间。
 * 拿不到图就是没有副本：页面只显示来源卡，不拿无关图片顶替。
 */
import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { RefImage } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";

type Client = pg.PoolClient;

/** 允许的图片类型与上限（和 PDF/论文同一个量级）。 */
export const REF_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const REF_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** 文件存放端口：由宿主实现（本地目录或对象存储），业务层不碰路径细节。 */
export type ExploreStorage = {
  /** 存一份副本，返回相对路径（只交给服务端读）。 */
  saveRef: (input: { dossier: string; refId: string; ext: string; bytes: Buffer }) => Promise<string>;
  readRef: (input: { dossier: string; path: string }) => Promise<{ bytes: Buffer; mime: string } | null>;
  removeRef: (input: { dossier: string; path: string }) => Promise<void>;
  /** 地图快照（页面导出的矢量底图）。 */
  saveSnapshot: (input: {
    dossier: string;
    revision: number;
    key: string;
    bytes: Buffer;
  }) => Promise<string>;
  readSnapshot: (input: { dossier: string; path: string }) => Promise<{ bytes: Buffer; mime: string } | null>;
  /** 计划书 PDF。 */
  saveBook: (input: { dossier: string; artifactId: string; bytes: Buffer }) => Promise<string>;
  readBook: (input: { dossier: string; path: string }) => Promise<{ bytes: Buffer; mime: string } | null>;
};

export const refImageUrl = (dossier: string, refId: string) =>
  `/v1/explore/plans/${dossier}/refs/${refId}/image`;

export function refImageOf(row: any): RefImage {
  const src = row.image_path ? refImageUrl(row.dossier_id, row.id) : null;
  return {
    id: row.id,
    origin: row.origin === "web" ? "web" : "upload",
    kind: row.kind === "same-spot" ? "same-spot" : "style",
    image: src ? { src } : null,
    ...(row.page_url
      ? { page: { url: row.page_url, ...(row.page_title ? { title: row.page_title } : {}) } }
      : {}),
    ...(row.author ? { author: row.author } : {}),
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.taken_at ? { takenAt: row.taken_at } : {}),
    ...(row.stop_id ? { stopId: row.stop_id } : {}),
  };
}

export async function listRefs(client: Client, account: string, dossier: string): Promise<RefImage[]> {
  const rows = (
    await client.query(
      `select id,dossier_id,origin,kind,image_path,page_url,page_title,author,platform,taken_at,stop_id
         from explore_ref where account_id=$1 and dossier_id=$2 and removed_at is null
        order by created_at limit 200`,
      [account, dossier],
    )
  ).rows;
  return rows.map(refImageOf);
}

export async function addUploadedRef(
  client: Client,
  storage: ExploreStorage,
  input: {
    account: string;
    dossier: string;
    bytes: Buffer;
    mime: string;
    kind: "same-spot" | "style";
    stopId?: string | null;
  },
): Promise<RefImage> {
  const ext = REF_IMAGE_TYPES[input.mime];
  if (!ext) throw new ApiFailure("REF_TYPE_UNSUPPORTED", 400, "参考图只支持 JPEG / PNG / WebP / GIF。");
  if (!input.bytes.length) throw new ApiFailure("REF_EMPTY", 400, "这张图是空的。");
  if (input.bytes.length > REF_IMAGE_MAX_BYTES)
    throw new ApiFailure("REF_TOO_LARGE", 413, "图片太大了，换一张小于 8MB 的。");
  const id = randomUUID();
  const path = await storage.saveRef({ dossier: input.dossier, refId: id, ext, bytes: input.bytes });
  const created = (
    await client.query(
      `insert into explore_ref(id,account_id,dossier_id,origin,kind,image_path,mime,stop_id)
       values($1,$2,$3,'upload',$4,$5,$6,$7)
       returning id,dossier_id,origin,kind,image_path,page_url,page_title,author,platform,taken_at,stop_id`,
      [id, input.account, input.dossier, input.kind, path, input.mime, input.stopId ?? null],
    )
  ).rows[0];
  return refImageOf(created);
}

/** 网图入档：拿得到就存副本；拿不到就只留来源（image 为 null）。 */
export async function addWebRef(
  client: Client,
  storage: ExploreStorage | undefined,
  input: {
    account: string;
    dossier: string;
    kind: "same-spot" | "style";
    stopId?: string | null;
    pageUrl?: string | null;
    pageTitle?: string | null;
    author?: string | null;
    platform?: string | null;
    takenAt?: string | null;
    image?: { bytes: Buffer; mime: string } | null;
  },
): Promise<RefImage> {
  const id = randomUUID();
  let path: string | null = null;
  let mime: string | null = null;
  const ext = input.image ? REF_IMAGE_TYPES[input.image.mime] : undefined;
  if (input.image && ext && storage && input.image.bytes.length <= REF_IMAGE_MAX_BYTES) {
    path = await storage.saveRef({ dossier: input.dossier, refId: id, ext, bytes: input.image.bytes });
    mime = input.image.mime;
  }
  const created = (
    await client.query(
      `insert into explore_ref(id,account_id,dossier_id,origin,kind,image_path,mime,page_url,page_title,author,platform,taken_at,stop_id)
       values($1,$2,$3,'web',$4,$5,$6,$7,$8,$9,$10,$11,$12)
       returning id,dossier_id,origin,kind,image_path,page_url,page_title,author,platform,taken_at,stop_id`,
      [
        id,
        input.account,
        input.dossier,
        input.kind,
        path,
        mime,
        input.pageUrl ?? null,
        input.pageTitle ?? null,
        input.author ?? null,
        input.platform ?? null,
        input.takenAt ?? null,
        input.stopId ?? null,
      ],
    )
  ).rows[0];
  return refImageOf(created);
}

export async function removeRef(
  client: Client,
  storage: ExploreStorage | undefined,
  input: { account: string; dossier: string; id: string },
): Promise<{ path: string | null }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id))
    throw new ApiFailure("REF_NOT_FOUND", 404, "找不到这张参考图。");
  const row = (
    await client.query(
      `update explore_ref set removed_at=now()
        where account_id=$1 and dossier_id=$2 and id=$3 and removed_at is null
        returning image_path`,
      [input.account, input.dossier, input.id],
    )
  ).rows[0];
  if (!row) throw new ApiFailure("REF_NOT_FOUND", 404, "找不到这张参考图。");
  // 记录先移除；文件删失败不影响用户看到的结果（下次清理）。
  if (row.image_path && storage)
    await storage.removeRef({ dossier: input.dossier, path: row.image_path }).catch(() => {});
  return { path: row.image_path ?? null };
}

/** 打开某张参考图的副本（只给本账户本档案）。 */
export async function readRefImage(
  client: Client,
  storage: ExploreStorage | undefined,
  input: { account: string; dossier: string; id: string },
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id))
    throw new ApiFailure("REF_NOT_FOUND", 404, "找不到这张参考图。");
  const row = (
    await client.query(
      "select image_path,mime from explore_ref where account_id=$1 and dossier_id=$2 and id=$3 and removed_at is null",
      [input.account, input.dossier, input.id],
    )
  ).rows[0];
  if (!row?.image_path) throw new ApiFailure("REF_NOT_FOUND", 404, "这张参考图没有副本，只有来源。");
  if (!storage) throw new ApiFailure("REF_STORAGE_UNAVAILABLE", 503, "参考图存储还没准备好。");
  const file = await storage.readRef({ dossier: input.dossier, path: row.image_path });
  if (!file) throw new ApiFailure("REF_NOT_FOUND", 404, "这张参考图的副本已经不在磁盘上了。");
  return { bytes: file.bytes, mime: row.mime ?? file.mime };
}

// ── 网图入档（06 §6.1：存副本、保留出处；拿不到就只留来源卡） ──────

/** 一次网图抓取的上限：图片 8MB，页面 2MB（只为了读 og:image）。 */
export const WEB_IMAGE_MAX_BYTES = REF_IMAGE_MAX_BYTES;
const WEB_PAGE_MAX_BYTES = 2 * 1024 * 1024;

/** 不许服务端去访问本机/内网地址：模型给的链接不能变成打自己人的工具。 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|::1$)/i;

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiFailure("REF_URL_INVALID", 400, "这个链接读不出来。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new ApiFailure("REF_URL_INVALID", 400, "只接受 http / https 链接。");
  const host = url.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || host.endsWith(".local") || host.endsWith(".internal"))
    throw new ApiFailure("REF_URL_FORBIDDEN", 400, "这个地址在本机或内网，不去取。");
  return url;
}

/**
 * 自己跳转、每一跳都验一遍地址：不让一次 302 把服务端带到内网去。
 * 最多 3 跳，每跳各自有时限。
 */
async function fetchFollowingRedirects(input: string, timeoutMs: number): Promise<any> {
  let current = assertFetchableUrl(input).href;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, {
      // 不少站点（维基、图床）会拒绝没有 UA 的请求；照实说明自己是谁。
      headers: { "user-agent": "ReinLab/1.0 (local travel-plan tool)" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (response.status < 300 || response.status >= 400 || !response.headers.get("location"))
      return response;
    const next = absoluteUrl(response.headers.get("location")!, current);
    if (!next) throw new Error("跳转到读不出来的地址");
    current = assertFetchableUrl(next).href;
  }
  throw new Error("跳转太多次");
}

export type WebRefMaterial = {
  image: { bytes: Buffer; mime: string } | null;
  page: { url: string; title?: string } | null;
  /** 没拿到图的原因（给人看的一句话）。 */
  warning?: string;
};

const absoluteUrl = (value: string, base: string): string | null => {
  try {
    return new URL(value, base).href;
  } catch {
    return null;
  }
};

const metaContent = (html: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1].trim();
  }
  return null;
};

/**
 * 取一张网图：直接是图片就存；是网页就找 og:image 再取一次。
 * 一律不跟随到内网、不无限读：超限、非图片、连不上都如实返回「没拿到图」。
 */
export async function fetchWebRef(
  target: string,
  options: {
    transport?: WeatherLikeTransport;
    timeoutMs?: number;
  } = {},
): Promise<WebRefMaterial> {
  const url = assertFetchableUrl(target);
  const transport: WeatherLikeTransport =
    options.transport ??
    ((input) => fetchFollowingRedirects(input, options.timeoutMs ?? 12_000));

  const read = async (href: string, maxBytes: number) => {
    assertFetchableUrl(href);
    const response = await transport(href);
    if (!response.ok) throw new Error(`返回 ${response.status}`);
    const declared = Number(response.headers?.get?.("content-length") ?? 0);
    if (declared && declared > maxBytes) throw new Error("文件太大");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("文件太大");
    return { bytes, mime: String(response.headers?.get?.("content-type") ?? "").split(";")[0].trim() };
  };

  try {
    const first = await read(url.href, WEB_IMAGE_MAX_BYTES);
    if (first.mime.startsWith("image/")) {
      const ext = REF_IMAGE_TYPES[first.mime];
      if (!ext) return { image: null, page: null, warning: `这种图片类型（${first.mime}）存不了，只记了来源。` };
      return { image: { bytes: first.bytes, mime: first.mime }, page: null };
    }
    // 不是图片：当网页读，找 og:image / twitter:image。
    const html = first.bytes.subarray(0, WEB_PAGE_MAX_BYTES).toString("utf8");
    const title =
      metaContent(html, [/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i]) ??
      metaContent(html, [/<title[^>]*>([^<]+)<\/title>/i]) ??
      undefined;
    const imageHref = metaContent(html, [
      /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    ]);
    const absolute = imageHref ? absoluteUrl(imageHref, url.href) : null;
    if (!absolute)
      return {
        image: null,
        page: { url: url.href, ...(title ? { title } : {}) },
        warning: "这个页面上没找到可取的图片，只记了来源。",
      };
    try {
      const picture = await read(absolute, WEB_IMAGE_MAX_BYTES);
      const ext = REF_IMAGE_TYPES[picture.mime];
      if (!picture.mime.startsWith("image/") || !ext)
        return {
          image: null,
          page: { url: url.href, ...(title ? { title } : {}) },
          warning: "页面里指向的不是能存的图片，只记了来源。",
        };
      return {
        image: { bytes: picture.bytes, mime: picture.mime },
        page: { url: url.href, ...(title ? { title } : {}) },
      };
    } catch (error) {
      return {
        image: null,
        page: { url: url.href, ...(title ? { title } : {}) },
        warning: `页面上那张图没取到（${String((error as Error)?.message ?? error).slice(0, 80)}），只记了来源。`,
      };
    }
  } catch (error) {
    return {
      image: null,
      page: { url: url.href },
      warning: `没取到图（${String((error as Error)?.message ?? error).slice(0, 100)}），只记了来源。`,
    };
  }
}

/** fetch 的最小形状：测试可以注入，不依赖 Node 的类型。 */
export type WeatherLikeTransport = (url: string) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get?: (name: string) => string | null };
  arrayBuffer: () => Promise<ArrayBuffer>;
}>;
