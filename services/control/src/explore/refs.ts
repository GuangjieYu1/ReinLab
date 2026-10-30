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
