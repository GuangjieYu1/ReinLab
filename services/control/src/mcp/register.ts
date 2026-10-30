/**
 * `papers.register`：把当前档案工作区里已经有的 PDF 登记为本档案论文。
 *
 * 获取材料与正式登记分开：Agent 怎么拿到 PDF（bash、复制、专业工具）不管，
 * 这里只负责「确认它是这个档案里的一份真实 PDF，然后按正式入档处理」。
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type pg from "pg";
import { ApiFailure } from "../api/errors";
import { pdfPages, type PaperDeposit } from "./papers";

/** 与既有 PDF 上限一致（8MB）。 */
const MAX_PDF = 8 * 1024 * 1024;
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export type WorkspaceRoots = {
  /** 宿主上的档案工作区根。 */
  host: string;
  /** 容器里看到的同一个目录（宿主模式下与 host 相同）。 */
  container: string;
};

/**
 * 把模型给的文件路径解析成宿主上的绝对路径。
 * 只接受「工作区内」的路径：容器路径前缀、或工作区内的相对路径。
 */
export function resolveInWorkspace(raw: unknown, roots: WorkspaceRoots): string {
  const input = text(raw);
  if (!input) throw new ApiFailure("PAPER_PATH_REQUIRED", 400, "需要一个工作区里的 PDF 路径。");
  if (input.includes("\0")) throw new ApiFailure("PAPER_PATH_INVALID", 400, "路径不合法。");
  const containerRoot = roots.container.replace(/\/+$/, "");
  let absolute: string;
  if (path.isAbsolute(input)) {
    if (containerRoot && containerRoot !== "" && input.startsWith(containerRoot + "/"))
      absolute = path.join(roots.host, input.slice(containerRoot.length + 1));
    else if (input.startsWith(roots.host + "/")) absolute = input;
    else
      throw new ApiFailure(
        "PAPER_PATH_OUTSIDE_WORKSPACE",
        400,
        "这个文件不在当前档案的工作区里，读不到。",
      );
  } else {
    absolute = path.join(roots.host, input);
  }
  const root = path.resolve(roots.host);
  const resolved = path.resolve(absolute);
  if (resolved !== root && !resolved.startsWith(root + path.sep))
    throw new ApiFailure("PAPER_PATH_OUTSIDE_WORKSPACE", 400, "这个文件不在当前档案的工作区里，读不到。");
  return resolved;
}

/** 读一份工作区 PDF：可读、是真 PDF、在大小上限内。返回内容与摘要。 */
export async function readWorkspacePdf(absolute: string): Promise<{ bytes: Buffer; digest: string }> {
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    throw new ApiFailure("PAPER_FILE_MISSING", 404, "工作区里找不到这个文件。");
  }
  if (info.isSymbolicLink() || !info.isFile())
    throw new ApiFailure("PAPER_FILE_INVALID", 400, "这需要是一个普通文件（不跟随符号链接）。");
  if (info.size > MAX_PDF)
    throw new ApiFailure("PAPER_FILE_TOO_LARGE", 413, "这个 PDF 太大了，超过 8MB。");
  const real = await realpath(absolute).catch(() => "");
  if (!real) throw new ApiFailure("PAPER_FILE_INVALID", 400, "这个文件读不到。");
  const bytes = await readFile(real).catch(() => null);
  if (!bytes) throw new ApiFailure("PAPER_FILE_INVALID", 400, "这个文件读不到。");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new ApiFailure("PAPER_PDF_INVALID", 400, "这个文件不是 PDF。");
  return { bytes, digest: sha(bytes) };
}

export type RegisterInput = {
  path: unknown;
  title: unknown;
  authors?: unknown;
  doi?: unknown;
  source?: unknown;
};

/** 只做「准备」：读文件、算摘要、整理元数据。这一步不动资产表。 */
export async function prepareRegistration(input: RegisterInput, roots: WorkspaceRoots) {
  const absolute = resolveInWorkspace(input.path, roots);
  const { bytes, digest } = await readWorkspacePdf(absolute);
  const title = text(input.title);
  if (!title) throw new ApiFailure("PAPER_TITLE_REQUIRED", 400, "登记论文需要一个标题。");
  let pageCount: number | null = null;
  let parseError: string | null = null;
  try {
    pageCount = (await pdfPages(bytes)).length;
  } catch {
    parseError = "这份 PDF 抽不出文本（可能是扫描件），入档后读不到正文；不编造全文或页码。";
  }
  const authors = Array.isArray(input.authors)
    ? input.authors.map((a) => text(a)).filter(Boolean)
    : text(input.authors)
      ? [text(input.authors)]
      : [];
  return {
    absolute,
    bytes,
    digest,
    metadata: {
      title: title.slice(0, 300),
      authors,
      doi: text(input.doi) || null,
      source: text(input.source) || null,
      pageCount,
      parseError,
    },
  };
}

/** 这个档案里同内容的资产是否已经入档。 */
export async function existingByDigest(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  digest: string,
) {
  const row = (
    await client.query(
      `select id "assetId",status,license,path,paper_id "paperId",view_metadata "viewMetadata"
         from paper_asset
        where account_id=$1 and dossier_id=$2 and sha256=$3 and status in ('full_text','abstract_only')
        order by created_at limit 1`,
      [account, dossier, digest],
    )
  ).rows[0];
  return row ?? null;
}

/**
 * 把 PDF 放进 papers.pages 读取的缓存目录（<cacheRoot>/<sha>.pdf）。
 * 与 papers.fetch 同样的规则：0700 目录、原子写入、已有且摘要一致就复用。
 */
export async function cachePdf(cacheRoot: string, bytes: Buffer, digest: string) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const file = path.join(cacheRoot, digest + ".pdf");
  try {
    const existing = await readFile(file);
    if (sha(existing) === digest) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(cacheRoot, "." + randomUUID() + ".pending");
  try {
    const h = await open(temporary, "wx", 0o600);
    try {
      await h.writeFile(bytes);
      await h.sync();
    } finally {
      await h.close();
    }
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * 正式入档：写文件 + 资产记录。已存在同摘要资产时直接返回，不重复建。
 * 内容在批准之后被换掉会在这里被摘要比对挡住。
 */
export async function commitRegistration(
  client: pg.PoolClient,
  deps: { deposit: PaperDeposit; context: any; cacheRoot: string },
  input: {
    account: string;
    dossier: string;
    run: string;
    prepared: Awaited<ReturnType<typeof prepareRegistration>>;
    expectedDigest: string;
  },
) {
  const { account, dossier, run, prepared, expectedDigest } = input;
  // 批准绑定的是当时那份内容：换掉了就不认。
  const again = await readWorkspacePdf(prepared.absolute);
  if (again.digest !== expectedDigest)
    throw new ApiFailure(
      "PAPER_FILE_CHANGED",
      409,
      "这个文件在你确认之后变过了，为免入档内容和批准的不一致，请重新登记。",
    );
  const existing = await existingByDigest(client, account, dossier, expectedDigest);
  if (existing) return { ...existing, reused: true };
  // papers.pages 从缓存目录读原文：不写这一份，入档后也读不到页（ENOENT）。
  if (prepared.metadata.parseError === null)
    await cachePdf(deps.cacheRoot, prepared.bytes, expectedDigest);

  const assetId = crypto.randomUUID();
  const metadata = {
    paperId: prepared.metadata.doi ?? "",
    source: prepared.metadata.source ?? prepared.absolute,
    status: prepared.metadata.parseError ? "parse_failed" : "full_text",
    isOpenAccess: true,
    viewMetadata: prepared.metadata,
  };
  const file = "papers/" + assetId + ".pdf";
  await deps.deposit(deps.context, assetId, prepared.bytes, {
    ...metadata,
    sha256: expectedDigest,
  });
  await client.query(
    "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract,view_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [
      assetId,
      account,
      dossier,
      run,
      prepared.metadata.doi ?? "",
      metadata.source,
      null,
      metadata.status,
      true,
      expectedDigest,
      file,
      // 工作区登记没有摘要字段：照实留空，不编造。
      "",
      JSON.stringify(prepared.metadata),
    ],
  );
  return {
    assetId,
    status: metadata.status,
    path: file,
    sha256: expectedDigest,
    reused: false,
    ...(prepared.metadata.parseError ? { reason: prepared.metadata.parseError } : {}),
  };
}
