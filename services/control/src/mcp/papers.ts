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
    locations: z
      .array(
        z.object({
          is_oa: z.boolean(),
          pdf_url: z.string().nullable(),
          license: z.string().nullable().optional(),
        }),
      )
      .max(50)
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
/**
 * Paper handles we accept. `W…` is an OpenAlex work, `arxiv:…` an arXiv id; a
 * bare arXiv id is normalized so a model quoting only the number still reads.
 */
function paperId(raw: unknown) {
  if (typeof raw !== "string") throw deny();
  if (/^W[0-9]{1,30}$/.test(raw)) return raw;
  if (/^arxiv:[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$/i.test(raw)) return raw.toLowerCase();
  if (/^[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$/.test(raw)) return "arxiv:" + raw;
  throw deny();
}
/** OpenAlex now meters anonymous traffic per IP budget; a key restores it. */
function openAlexKey() {
  return (process.env.OPENALEX_API_KEY ?? "").trim();
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
const ARXIV_API = "https://export.arxiv.org/api/query";
/** One paper as `papers.fetch` sees it, whatever upstream produced it. */
type PaperRecord = {
  bytes: Buffer | null;
  fileUrl: string;
  recordUrl: string;
  license: string | null;
  isOpenAccess: boolean;
  abstractText: string;
  viewMetadata: {
    title: string | null;
    authors: string[];
    venue: string | null;
    sizeBytes: number | null;
  };
};
const decodeXml = (value: string) =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
type ArxivEntry = { id: string; title: string; summary: string; abs: string; authors: string[] };
/** arXiv answers in Atom, so the fields we need are read without an XML dependency. */
function atomEntries(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  for (const [, body] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const pick = (tag: string) =>
      decodeXml(body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))?.[1] ?? "");
    const abs = pick("id"),
      id = abs.replace(/^.*\/abs\//, "");
    if (!/^[0-9]{4}\.[0-9]{4,5}(v[0-9]+)?$/i.test(id)) continue;
    entries.push({
      id,
      abs,
      title: pick("title").slice(0, 1000),
      summary: pick("summary"),
      authors: [...body.matchAll(/<name>([\s\S]*?)<\/name>/g)]
        .map(([, name]) => decodeXml(name).slice(0, 300))
        .filter(Boolean)
        .slice(0, 50),
    });
  }
  return entries;
}
/** arXiv throttles abrupt sequences: one short retry keeps a reading session moving. */
async function arxivGet(http: PaperHttp, egress: string[], url: string, maximum: number) {
  let response = await http.get(url, egress, maximum);
  if (response.status === 429 || response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await http.get(url, egress, maximum);
  }
  return response;
}
async function arxivPapers(
  http: PaperHttp,
  egress: string[],
  query: string,
  limit: number,
) {
  // arXiv reads `all:` as AND over terms; punctuation would be parsed as syntax,
  // and function words only narrow the result set.
  const stop = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "with", "is", "are", "how", "what", "why", "does", "do", "themselves", "its", "their", "we", "can", "using"]);
  const terms = query
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 1 && !stop.has(term.toLowerCase()))
    .slice(0, 12);
  if (!terms.length) throw new ApiFailure("PAPERS_QUERY_EMPTY", 400, "检索词为空。");
  // A long question is all-AND and easily matches nothing, so the search narrows
  // from the full phrase to its head terms instead of answering "没找到" too early.
  const ladder = [...new Set([Math.min(terms.length, 8), 3, 1])]
    .filter((size) => size <= terms.length)
    .sort((a, b) => b - a);
  for (const [attempt, size] of ladder.entries()) {
    const url = new URL(ARXIV_API);
    url.searchParams.set(
      "search_query",
      terms.slice(0, size).map((term) => "all:" + term).join(" AND "),
    );
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.min(limit, 20)));
    url.searchParams.set("sortBy", "relevance");
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    const response = await arxivGet(http, egress, url.href, 1024 * 1024);
    if (response.status !== 200)
      throw new ApiFailure("PAPERS_UPSTREAM_STATUS", 503, `检索来源返回 ${response.status}，暂不可用。`);
    const papers = atomEntries(response.bytes.toString("utf8")).map((entry) => ({
      paperId: "arxiv:" + entry.id,
      title: entry.title,
      source: entry.abs || "https://arxiv.org/abs/" + entry.id,
      isOpenAccess: true,
    }));
    if (papers.length) return papers;
  }
  return [];
}
async function arxivRecord(
  http: PaperHttp,
  egress: string[],
  id: string,
): Promise<PaperRecord> {
  const url = new URL(ARXIV_API);
  url.searchParams.set("id_list", id);
  const response = await arxivGet(http, egress, url.href, 1024 * 1024);
  if (response.status !== 200)
    throw new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文元数据暂不可用。");
  const entry = atomEntries(response.bytes.toString("utf8"))[0];
  if (!entry) throw deny();
  const fileUrl = "https://arxiv.org/pdf/" + id;
  let bytes: Buffer | null = null;
  try {
    const pdf = await arxivGet(http, egress, fileUrl, MAX_PDF);
    if (pdf.status === 200 && pdf.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      await pdfPages(pdf.bytes);
      bytes = pdf.bytes;
    }
  } catch (error) {
    if (error instanceof ApiFailure && error.code === "PAPERS_EGRESS_DENIED") throw error;
  }
  return {
    bytes,
    fileUrl,
    recordUrl: entry.abs || "https://arxiv.org/abs/" + id,
    // arXiv preprints carry no per-item licence URL; openness is stated, terms are not invented.
    license: null,
    isOpenAccess: true,
    abstractText: entry.summary,
    viewMetadata: {
      title: entry.title,
      authors: entry.authors,
      venue: "arXiv",
      sizeBytes: bytes?.length ?? null,
    },
  };
}
async function openAlexPapers(
  http: PaperHttp,
  egress: string[],
  query: string,
  limit: number,
) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(limit));
  url.searchParams.set("api_key", openAlexKey());
  const response = await http.get(url.href, egress, 1024 * 1024);
  if (response.status !== 200)
    throw new ApiFailure("PAPERS_UPSTREAM_STATUS", 503, `检索来源返回 ${response.status}，暂不可用。`);
  let body: unknown;
  try {
    body = JSON.parse(response.bytes.toString("utf8"));
  } catch {
    throw new ApiFailure("PAPERS_UPSTREAM_INVALID", 503, "检索来源返回的不是 JSON，暂不可用。");
  }
  const parsed = z.object({ results: z.array(Work).max(20) }).safeParse(body);
  if (!parsed.success) {
    const detail =
      typeof (body as { message?: unknown })?.message === "string"
        ? String((body as { message?: string }).message).slice(0, 120)
        : "缺少 results 字段";
    throw new ApiFailure("PAPERS_UPSTREAM_INVALID", 503, `检索来源返回异常：${detail}`);
  }
  return parsed.data.results.map((work) => ({
    paperId: paperId(work.id.split("/").at(-1)),
    title: work.title ?? "",
    source: work.id,
    isOpenAccess: work.open_access?.is_oa === true,
  }));
}
async function openAlexRecord(
  http: PaperHttp,
  egress: string[],
  id: string,
): Promise<PaperRecord> {
  const url = new URL("https://api.openalex.org/works/" + id);
  if (openAlexKey()) url.searchParams.set("api_key", openAlexKey());
  const response = await http.get(url.href, egress, 1024 * 1024);
  if (response.status !== 200)
    throw new ApiFailure("PAPERS_UNAVAILABLE", 503, "论文元数据暂不可用。");
  const work = Work.parse(JSON.parse(response.bytes.toString("utf8")));
  if (work.id !== "https://openalex.org/" + id) throw deny();
  // `best_oa_location` is not always downloadable: OpenAlex may point it at a
  // non-OA record while another listed location has the arXiv PDF. Prefer the
  // first location that is openly available with a PDF, then fall back.
  const location =
    (work.locations ?? []).find((entry) => entry.is_oa && entry.pdf_url) ?? work.best_oa_location;
  let bytes: Buffer | null = null;
  const abstractText = abstract(work);
  // A licensed re-use statement is recorded when the source states one, but it
  // is not a precondition for reading an openly available PDF: a missing
  // license is stored as null instead of silently downgrading to abstract-only.
  if (work.open_access?.is_oa && location?.is_oa && location.pdf_url) {
    try {
      const pdf = await http.get(location.pdf_url, egress, MAX_PDF);
      if (pdf.status === 200 && pdf.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        await pdfPages(pdf.bytes);
        bytes = pdf.bytes;
      }
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "PAPERS_EGRESS_DENIED") throw error;
    }
  }
  const rawWork = work as Record<string, any>;
  return {
    bytes,
    fileUrl: location?.pdf_url ?? work.id,
    recordUrl: work.id,
    license: location?.license ?? null,
    isOpenAccess: work.open_access?.is_oa === true,
    abstractText,
    viewMetadata: {
      title: typeof work.title === "string" ? work.title.slice(0, 1000) : null,
      authors: Array.isArray(rawWork.authorships)
        ? rawWork.authorships.slice(0, 50).flatMap((a: any) =>
            typeof a?.author?.display_name === "string"
              ? [a.author.display_name.slice(0, 300)]
              : [],
          )
        : [],
      venue:
        typeof rawWork.primary_location?.source?.display_name === "string"
          ? rawWork.primary_location.source.display_name.slice(0, 500)
          : null,
      sizeBytes: bytes?.length ?? null,
    },
  };
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
    const egress = context.catalog.capabilities["papers.search"].egress,
      query = String(args.query),
      limit = Number(args.limit ?? 10);
    const result = {
      papers: openAlexKey()
        ? await openAlexPapers(http, egress, query, limit)
        : await arxivPapers(http, egress, query, limit),
    };
    if (context.claims.role === "research-clarify") captureSearch(result, []);
    return result;
  };
  handlers["papers.fetch"] = async (context, args) => {
    const id = paperId(args.paperId),
      cap = context.catalog.capabilities["papers.fetch"],
      record = id.startsWith("arxiv:")
        ? await arxivRecord(http, cap.egress, id.slice("arxiv:".length))
        : await openAlexRecord(http, cap.egress, id),
      assetId = randomUUID(),
      digest = record.bytes ? await cache(record.bytes) : null,
      status = record.bytes ? "full_text" : "abstract_only",
      source = record.bytes ? record.fileUrl : record.recordUrl,
      metadata = {
        paperId: id,
        source,
        license: record.license,
        isOpenAccess: record.isOpenAccess,
        status,
        abstract: record.abstractText,
        sha256: digest,
      };
    // The shared server never receives a user's volume. Only the control-plane port deposits files.
    await deposit(context, assetId, record.bytes, {
      ...metadata,
      ...(scrub(record.viewMetadata) as object),
    });
    const file = "papers/" + assetId + (record.bytes ? ".pdf" : ".json");
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
          record.license,
          status,
          metadata.isOpenAccess,
          digest,
          file,
          record.abstractText,
          JSON.stringify(scrub(record.viewMetadata)),
        ]
      )
    );
    return {
      assetId,
      status,
      source,
      license: record.license,
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
