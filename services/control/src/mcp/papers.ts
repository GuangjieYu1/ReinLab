import { constants } from "node:fs";
import {
  mkdir,
  open,
  realpath,
  lstat,
  mkdtemp,
  writeFile,
  rm,
  rename,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Database } from "../db/database";
import { ApiFailure } from "../api/errors";
import { scrub } from "../ledger";
import { captureSearch } from "../clarify/candidates";
import { PaperHttp } from "./paper-http";
import type { AuthorizedCapability } from "./authority";
import type { CapabilityHandler } from "./engine";
const exec = promisify(execFile),
  MAX_PDF = 8 * 1024 * 1024;
const Work = z
  .object({
    id: z.string(),
    title: z.string().nullable().optional(),
    open_access: z.object({ is_oa: z.boolean() }).optional(),
    best_oa_location: z
      .object({
        is_oa: z.boolean(),
        pdf_url: z.string().nullable(),
        license: z.string().nullable(),
      })
      .nullable()
      .optional(),
    abstract_inverted_index: z
      .record(z.array(z.number().int().min(0).max(200000)))
      .nullable()
      .optional(),
  })
  .passthrough();
const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const deny = () =>
  new ApiFailure(
    "PAPER_SCOPE_DENIED",
    403,
    "论文不属于本档案，或来源不在允许范围。"
  );
function paperId(raw: unknown) {
  if (typeof raw !== "string" || !/^W[0-9]{1,30}$/.test(raw)) throw deny();
  return raw;
}
function abstract(work: z.infer<typeof Work>) {
  const words = new Map<number, string>();
  for (const [word, positions] of Object.entries(
    work.abstract_inverted_index ?? {}
  ))
    for (const i of positions) words.set(i, word);
  const text = [...words]
    .sort(([a], [b]) => a - b)
    .map(([, word]) => word)
    .join(" ");
  if (Buffer.byteLength(text) > 262144)
    throw new ApiFailure("PAPER_TOO_LARGE", 413, "论文摘要超过大小限制。");
  return text;
}
export async function pdfPages(bytes: Buffer): Promise<string[]> {
  if (
    bytes.length > MAX_PDF ||
    !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
  )
    throw new ApiFailure("PAPER_PDF_INVALID", 400, "全文不是有效的有界 PDF。");
  const dir = await mkdtemp(path.join(tmpdir(), "reinlab-paper-text-"));
  try {
    const file = path.join(dir, "source.pdf");
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await exec(
      "pdftotext",
      ["-q", "-layout", "-enc", "UTF-8", file, "-"],
      {
        encoding: "utf8",
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
        env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" },
      }
    );
    const pages = stdout.split("\f");
    if (pages.at(-1) === "") pages.pop();
    if (!pages.length || pages.length > 1000) throw new Error();
    return pages.map((p) => p.trim());
  } catch {
    throw new ApiFailure(
      "PAPER_TEXT_UNAVAILABLE",
      503,
      "PDF 文本层暂无法解析。"
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export type PaperDeposit = (
  context: AuthorizedCapability,
  assetId: string,
  bytes: Buffer | null,
  metadata: Record<string, unknown>
) => Promise<void>;
export function paperHandlers(
  db: Database,
  cacheRoot: string,
  deposit: PaperDeposit,
  http = new PaperHttp()
): Record<string, CapabilityHandler> {
  const cache = async (bytes: Buffer) => {
    await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
    if (
      (await realpath(cacheRoot)) !== cacheRoot ||
      (await lstat(cacheRoot)).mode & 0o077
    )
      throw deny();
    const name = sha(bytes),
      file = path.join(cacheRoot, name + ".pdf");
    let existing;
    try {
      existing = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      const st = await existing.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_PDF) throw deny();
      if (sha(await existing.readFile()) === name) return name;
      // A truncated old cache is repaired only from the newly validated public PDF.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      await existing?.close();
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
      const directory = await open(
        cacheRoot,
        constants.O_RDONLY | constants.O_DIRECTORY
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return name;
  };
  const handlers: Record<string, CapabilityHandler> = {};
  handlers["papers.search"] = async (context, args) => {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", String(args.query));
    url.searchParams.set("per-page", String(args.limit ?? 10));
    const response = await http.get(
      url.href,
      context.catalog.capabilities["papers.search"].egress,
      1024 * 1024
    );
    if (response.status !== 200)
      throw new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文检索来源暂不可用。");
    const results = z
      .array(Work)
      .max(20)
      .parse(JSON.parse(response.bytes.toString("utf8")).results);
    const result = {
      papers: results.map((work) => ({
        paperId: paperId(work.id.split("/").at(-1)),
        title: work.title ?? "",
        source: work.id,
        isOpenAccess: work.open_access?.is_oa === true,
      })),
    };
    if (context.claims.role === "research-clarify")
      captureSearch(result, results);
    return result;
  };
  handlers["papers.fetch"] = async (context, args) => {
    const id = paperId(args.paperId),
      cap = context.catalog.capabilities["papers.fetch"];
    const response = await http.get(
      "https://api.openalex.org/works/" + id,
      cap.egress,
      1024 * 1024
    );
    if (response.status !== 200)
      throw new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文元数据暂不可用。");
    const work = Work.parse(JSON.parse(response.bytes.toString("utf8")));
    if (work.id !== "https://openalex.org/" + id) throw deny();
    const assetId = randomUUID(),
      location = work.best_oa_location,
      abstractText = abstract(work);
    let bytes: Buffer | null = null,
      license = location?.license ?? null,
      source = work.id;
    if (
      work.open_access?.is_oa &&
      location?.is_oa &&
      location.pdf_url &&
      license
    ) {
      try {
        const pdf = await http.get(location.pdf_url, cap.egress, MAX_PDF);
        if (
          pdf.status === 200 &&
          pdf.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
        ) {
          await pdfPages(pdf.bytes);
          bytes = pdf.bytes;
          source = location.pdf_url;
        }
      } catch (error) {
        if (
          error instanceof ApiFailure &&
          error.code === "PAPERS_EGRESS_DENIED"
        )
          throw error; /* Closed/unavailable full text remains explicitly abstract-only. */
      }
    }
    const digest = bytes ? await cache(bytes) : null,
      status = bytes ? "full_text" : "abstract_only",
      metadata = {
        paperId: id,
        source,
        license,
        isOpenAccess: work.open_access?.is_oa === true,
        status,
        abstract: abstractText,
        sha256: digest,
      };
    const rawWork = work as Record<string, any>;
    const viewMetadata = {
      title: typeof work.title === "string" ? work.title.slice(0, 1000) : null,
      authors: Array.isArray(rawWork.authorships)
        ? rawWork.authorships
            .slice(0, 50)
            .flatMap((a: any) =>
              typeof a?.author?.display_name === "string"
                ? [a.author.display_name.slice(0, 300)]
                : []
            )
        : [],
      venue:
        typeof rawWork.primary_location?.source?.display_name === "string"
          ? rawWork.primary_location.source.display_name.slice(0, 500)
          : null,
      sizeBytes: bytes?.length ?? null,
    };
    // The shared server never receives a user's volume. Only the control-plane port deposits files.
    await deposit(context, assetId, bytes, {
      ...metadata,
      ...(scrub(viewMetadata) as object),
    });
    const file = "papers/" + assetId + (bytes ? ".pdf" : ".json");
    await db.withAccount(context.claims.account, (c) =>
      c.query(
        "insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract,view_metadata) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          assetId,
          context.claims.account,
          context.claims.dossier,
          context.claims.run,
          id,
          source,
          license,
          status,
          metadata.isOpenAccess,
          digest,
          file,
          abstractText,
          JSON.stringify(scrub(viewMetadata)),
        ]
      )
    );
    return {
      assetId,
      status,
      source,
      license,
      isOpenAccess: metadata.isOpenAccess,
      path: file,
    };
  };
  handlers["papers.pages"] = async (context, args) => {
    const asset = await db.withAccount(
      context.claims.account,
      async (c) =>
        (
          await c.query(
            "select * from paper_asset where id=$1 and dossier_id=$2",
            [args.assetId, context.claims.dossier]
          )
        ).rows[0]
    );
    if (!asset) throw deny();
    if (asset.status !== "full_text")
      return { assetId: asset.id, status: "abstract_only", pages: [] };
    const root = await realpath(cacheRoot);
    if (root !== cacheRoot || !/^([a-f0-9]{64})$/.test(asset.sha256))
      throw deny();
    const h = await open(
      path.join(root, asset.sha256 + ".pdf"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    let bytes: Buffer;
    try {
      const s = await h.stat();
      if (!s.isFile() || s.nlink !== 1 || s.size > MAX_PDF) throw deny();
      bytes = await h.readFile();
    } finally {
      await h.close();
    }
    if (sha(bytes) !== asset.sha256) throw deny();
    const all = await pdfPages(bytes);
    const requested = z
      .array(z.number().int().positive())
      .min(1)
      .max(20)
      .parse(args.pages);
    if (requested.some((p) => p > all.length))
      throw new ApiFailure("PAPER_PAGE_INVALID", 400, "页码超出原始 PDF。");
    return {
      assetId: asset.id,
      status: "full_text",
      pages: requested.map((page) => ({
        page,
        anchor: "paper:" + asset.id + "#page=" + page,
        text: all[page - 1],
      })),
    };
  };
  return handlers;
}
