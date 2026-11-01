/**
 * JPG 续传上传：tus 协议（design/prd/09-explore-v2.md §5.1、10-explore-v2-contract.md §2.3）。
 *
 * 用 tus 官方 server，不自创分片协议。每个请求（创建 / 查询 / 补传 / 终止）都按会话
 * 校验同账户档案：Cookie 里没有有效会话就 401，上传 id 不属于这个账户就 404，
 * 写请求必须带 X-ReinLab-CSRF: 1（跨站页面设不了这个头）。
 * 元数据约定：batchId、filename、lastModified。
 */
import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type pg from "pg";
import type { Database } from "../db/database";
import { BrowserSessions, sessionFailure, sessionState, SESSION_COOKIE } from "../api/browser-session";
import { loadPlan } from "./service";
import { finishUpload, readBatch, readUpload, registerUpload, type PhotoDeps } from "./photos";
import type { PhotoStore } from "./photo-store";

type Client = pg.PoolClient;

export type UploadsOptions = {
  db: Database;
  sessions: BrowserSessions;
  store: PhotoStore;
  deps: PhotoDeps;
  /** 每传完一张推一次进度。 */
  publish: (account: string, event: Record<string, unknown>) => void;
};

/** tus 的错误响应形状：状态码 + JSON 体（前端只看 message）。 */
const fail = (status: number, code: string, message: string) => {
  const error = new Error(message) as Error & { status_code?: number; body?: string };
  error.status_code = status;
  error.body = JSON.stringify({ code, message });
  throw error;
};

const headersOf = (req: unknown): Headers => {
  const value = (req as { headers?: unknown })?.headers;
  if (value instanceof Headers) return value;
  return new Headers((value ?? {}) as Record<string, string>);
};

function cookieToken(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) {
      const token = rest.join("=");
      return token && token.length >= 32 && token.length <= 128 ? token : null;
    }
  }
  return null;
}

/** 每个请求都从 Cookie 认身份：会话必须在有效期内。 */
async function accountOf(sessions: BrowserSessions, headers: Headers): Promise<string> {
  const token = cookieToken(headers.get("cookie"));
  if (!token) throw fail(401, "NO_SESSION", "请先登录。");
  const row = await sessions.read(token);
  if (!row) throw fail(401, "NO_SESSION", "请先登录。");
  const state = sessionState(row, Date.now());
  if (state !== "active") {
    const failure = sessionFailure(state);
    throw fail(failure.status, failure.code, failure.message);
  }
  return row.account_id;
}

export function createUploads(options: UploadsOptions) {
  const { db, sessions, store, deps } = options;

  const server = new Server({
    path: "/v1/explore/uploads",
    datastore: new FileStore({ directory: store.uploadsDir() }),
    // 单张 64 MB 上限：够收相机原图，也挡住误传的整段视频。
    maxSize: 64 * 1024 * 1024,
    // 回绝对地址，并把页面用的 /backend 前缀带上：控制面看到的路径是 /v1/...，
    // 浏览器那边是 /backend/v1/...（LAN 与 Vite 开发代理都认这个前缀）。
    respectForwardedHeaders: true,
    generateUrl: (req, { id }) => {
      const proto = (headersOf(req).get("x-forwarded-proto") ?? "").split(",")[0].trim() || "http";
      const host = (headersOf(req).get("x-forwarded-host") ?? "").split(",")[0].trim() || headersOf(req).get("host") || "127.0.0.1";
      return `${proto}://${host}/backend/v1/explore/uploads/${id}`;
    },
    allowedHeaders: ["X-ReinLab-CSRF"],
    async onIncomingRequest(req, uploadId) {
      const headers = headersOf(req);
      const account = await accountOf(sessions, headers);
      const method = String((req as { method?: string }).method ?? "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD" && headers.get("x-reinlab-csrf") !== "1")
        throw fail(403, "CSRF_REQUIRED", "缺少防伪造请求头。");
      // 创建时 id 刚生成、行还没写（onUploadCreate 会写），这里只管已有上传。
      if (method !== "POST" && uploadId) {
        // 知道上传地址不等于有权限：id 必须属于这个账户。
        const row = await db.withAccount(account, (client) => readUpload(client, uploadId));
        if (!row || row.account_id !== account)
          throw fail(404, "PHOTO_UPLOAD_NOT_FOUND", "这次上传不在了。");
      }
    },
    async onUploadCreate(req, upload) {
      const headers = headersOf(req);
      const account = await accountOf(sessions, headers);
      const metadata = upload.metadata ?? {};
      const batchId = String(metadata.batchId ?? "");
      const fileName = String(metadata.filename ?? "");
      if (!/^[0-9a-f-]{36}$/i.test(batchId) || !fileName)
        throw fail(400, "PHOTO_METADATA_REQUIRED", "上传要带批次号和文件名。");
      await db.withAccount(account, async (client) => {
        const batch = (
          await client.query("select dossier_id from explore_photo_batch where account_id=$1 and id=$2", [
            account,
            batchId,
          ])
        ).rows[0];
        if (!batch) throw fail(404, "PHOTO_BATCH_NOT_FOUND", "找不到这个上传批次。");
        const lastModified = Number(metadata.lastModified ?? 0);
        await registerUpload(
          client,
          {
            account,
            dossier: String(batch.dossier_id),
            uploadId: upload.id,
            batchId,
            fileName,
            length: Number(upload.size ?? 0),
            lastModified: Number.isFinite(lastModified) && lastModified > 0 ? lastModified : null,
          },
          deps,
        );
      });
      return { metadata: upload.metadata };
    },
    async onUploadFinish(_req, upload) {
      // tus 只给上传 id：归属由 definer 函数查（表本身对应用角色仍按账户隔离）。
      const owner = (
        await db.withSystem((client) =>
          client.query("select acc account_id, dos dossier_id from reinlab_photo_upload_owner($1)", [upload.id]),
        )
      ).rows[0] as { account_id: string; dossier_id: string } | undefined;
      if (!owner) throw fail(404, "PHOTO_UPLOAD_NOT_FOUND", "这次上传不在了。");
      const settled = await db.withAccount(owner.account_id, async (client: Client) => {
        const { plan } = await loadPlan(client, owner.account_id, owner.dossier_id);
        const outcome = await finishUpload(
          client,
          {
            account: owner.account_id,
            dossier: owner.dossier_id,
            uploadId: upload.id,
            document: plan.document,
          },
          deps,
        );
        const row = await readUpload(client, upload.id);
        const counts = row ? await readBatch(client, owner.account_id, owner.dossier_id, row.batch_id) : null;
        return { outcome, counts };
      });
      if (settled.counts)
        options.publish(owner.account_id, {
          type: "explore.photos",
          dossierId: owner.dossier_id,
          batchId: settled.counts.id,
          uploaded: settled.counts.uploaded,
          processed: settled.counts.processed,
          failed: settled.counts.failed,
        });
      // 单张失败不拦上传本身：照片记录里已经是 failed 并且带原因，页面照实显示。
      return {};
    },
  });

  return {
    server,
    /** Hono 里用它处理一次请求（Web Request → Web Response）。 */
    async handle(request: Request): Promise<Response> {
      try {
        return await server.handleWeb(request);
      } catch (error) {
        const shaped = error as { status_code?: number; body?: string; message?: string };
        return new Response(
          shaped.body ??
            JSON.stringify({ code: "UPLOAD_FAILED", message: shaped.message ?? "上传没完成。" }),
          {
            status: shaped.status_code ?? 500,
            headers: { "content-type": "application/json; charset=UTF-8" },
          },
        );
      }
    },
  };
}

export type Uploads = ReturnType<typeof createUploads>;
