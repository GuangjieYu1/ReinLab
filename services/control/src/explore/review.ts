/**
 * 回顾成果：计划 vs 实际、游记（design/prd/09-explore-v2.md §6、10-explore-v2-contract.md §2.5）。
 *
 * 三条照实说：
 * - 「没找到拍摄证据」不等于没去；打卡不等于开拍，时间不准时 lateMin 给 null，不硬算；
 * - 游记只用真实碎片（打卡、照片、笔记）和计划，没有素材的地方不编；
 * - 导出是同一份正文的两种格式，作为档案成果可再打开。
 */
import type pg from "pg";
import type { Comparison, Photo, Source, Travelogue } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import type { PlanDocument } from "./plan";
import { listFieldEvents } from "./field";

type Client = pg.PoolClient;

const hm = (iso: string) => (iso.length >= 16 ? iso.slice(11, 16) : iso);

const litText = (stop: PlanDocument["stops"][number]): string | null => {
  const lit = stop.light?.lit;
  if (!lit?.length) return null;
  return `地形见光 ${lit.map((row) => `${hm(row.start)}–${hm(row.end)}`).join("、")}（晴空假设）`;
};

/**
 * 计划 vs 实际：每个停留点给出证据类型、实际开始时间与迟到分钟数。
 *
 * 实际开始时间优先用「时间可信的、落位到这个点的照片」；没有照片才退回拍到了/到了的打卡。
 * 只有到了的打卡不给迟到分钟（打卡可能晚于快门，也可能只是路过）。
 */
export async function buildComparison(
  client: Client,
  input: { account: string; dossier: string; revision: number; document: PlanDocument },
): Promise<Comparison> {
  const events = await listFieldEvents(client, { account: input.account, dossier: input.dossier, document: input.document });
  const photos = (
    await client.query(
      `select id,placement_stop_id,placement_basis,corrected_ts,time_trust,picked
         from explore_photo where account_id=$1 and dossier_id=$2 and deleted_at is null and status='ready'
        order by created_at asc limit 5000`,
      [input.account, input.dossier],
    )
  ).rows as {
    id: string;
    placement_stop_id: string | null;
    placement_basis: string;
    corrected_ts: Date | null;
    time_trust: string;
    picked: boolean;
  }[];

  const notesAt = (stopId: string) =>
    events
      .filter((event) => event.stopId === stopId && event.kind === "note" && event.status === "ok")
      .map((event) => event.effectiveText ?? event.text ?? "")
      .filter(Boolean)
      .slice(0, 8);

  const items: Comparison["items"] = input.document.stops.map((stop) => {
    const mine = photos.filter((photo) => photo.placement_stop_id === stop.id);
    const shotEvents = events.filter(
      (event) => event.stopId === stop.id && event.kind === "shot" && event.status === "ok",
    );
    const arrivedEvents = events.filter(
      (event) => event.stopId === stop.id && event.kind === "arrived" && event.status === "ok",
    );
    const timedShots = mine
      .filter((photo) => photo.corrected_ts && photo.time_trust === "certain")
      .map((photo) => new Date(photo.corrected_ts!).getTime())
      .sort((a, b) => a - b);
    const planned = stop.window ? Date.parse(stop.window.start) : null;

    let actualStart: number | null = null;
    let lateMin: number | null = null;
    if (timedShots.length) {
      actualStart = timedShots[0];
      if (planned !== null && !Number.isNaN(planned))
        lateMin = Math.round((actualStart - planned) / 60000);
    } else if (shotEvents.length) {
      const when = shotEvents.map((event) => Date.parse(event.at)).filter((value) => !Number.isNaN(value));
      if (when.length) {
        actualStart = Math.min(...when);
        if (planned !== null && !Number.isNaN(planned))
          lateMin = Math.round((actualStart - planned) / 60000);
      }
    } else if (arrivedEvents.length) {
      const when = arrivedEvents.map((event) => Date.parse(event.at)).filter((value) => !Number.isNaN(value));
      // 到了不等于开拍：给实际到达时间，但不给迟到分钟。
      if (when.length) actualStart = Math.min(...when);
    }

    return {
      stopId: stop.id,
      stopName: stop.name,
      evidence: mine.length || shotEvents.length ? "shot" : arrivedEvents.length ? "arrived_only" : "none_found",
      plannedStart: stop.window?.start ?? null,
      actualStart: actualStart === null ? null : new Date(actualStart).toISOString(),
      lateMin,
      light: litText(stop),
      notes: notesAt(stop.id),
      photoIds: mine.map((photo) => photo.id),
    };
  });

  return {
    revisionUsed: input.revision,
    items,
    unplannedPhotoIds: photos
      .filter((photo) => photo.placement_basis === "unplanned" || (!photo.placement_stop_id && photo.placement_basis === "pending" && false))
      .map((photo) => photo.id),
  };
}

// ── 游记 ─────────────────────────────────────────────────

type TravelogueRow = {
  revision: number;
  markdown: string;
  photo_ids: string[];
  sources: Source[];
  created_at: Date;
};

const travelogueOf = (dossier: string, row: TravelogueRow): Travelogue => ({
  id: `${dossier}:${row.revision}`,
  revision: Number(row.revision),
  markdown: row.markdown,
  photoIds: Array.isArray(row.photo_ids) ? row.photo_ids : [],
  sources: Array.isArray(row.sources) ? row.sources : [],
  updatedAt: new Date(row.created_at).toISOString(),
});

export async function latestTravelogue(client: Client, account: string, dossier: string): Promise<Travelogue | null> {
  const row = (
    await client.query(
      `select revision,markdown,photo_ids,sources,created_at from explore_travelogue
        where account_id=$1 and dossier_id=$2 order by revision desc limit 1`,
      [account, dossier],
    )
  ).rows[0] as TravelogueRow | undefined;
  return row ? travelogueOf(dossier, row) : null;
}

/** 正文里提到哪些照片与外部链接：只留真存在的照片 id。 */
async function references(client: Client, account: string, dossier: string, markdown: string) {
  const ids = [...new Set(markdown.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [])];
  const photoIds = ids.length
    ? (
        await client.query(
          "select id from explore_photo where account_id=$1 and dossier_id=$2 and deleted_at is null and id = any($3::uuid[])",
          [account, dossier, ids],
        )
      ).rows.map((row) => String(row.id))
    : [];
  const sources: Source[] = [];
  for (const match of markdown.matchAll(/\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g)) {
    if (sources.length >= 20) break;
    sources.push({ name: match[1], url: match[2] });
  }
  return { photoIds, sources };
}

/** 保存一版游记：带 baseRevision 的乐观并发，冲突就 409 并给最新正文。 */
export async function saveTravelogue(
  client: Client,
  input: { account: string; dossier: string; baseRevision: number; markdown: string },
): Promise<Travelogue> {
  const markdown = String(input.markdown ?? "").trim();
  if (!markdown) throw new ApiFailure("INVALID_INPUT", 400, "游记还是空的。");
  if (markdown.length > 200_000) throw new ApiFailure("INVALID_INPUT", 400, "游记太长了。");
  const latest = (
    await client.query(
      "select coalesce(max(revision),0)::int n from explore_travelogue where account_id=$1 and dossier_id=$2",
      [input.account, input.dossier],
    )
  ).rows[0].n as number;
  if (Number(input.baseRevision) !== latest)
    throw new ApiFailure("REVISION_CONFLICT", 409, "游记刚被改过，请用最新版本再改。", {
      latest: await latestTravelogue(client, input.account, input.dossier),
    });
  const { photoIds, sources } = await references(client, input.account, input.dossier, markdown);
  const row = (
    await client.query(
      `insert into explore_travelogue(account_id,dossier_id,revision,markdown,photo_ids,sources)
       values($1,$2,$3,$4,$5::jsonb,$6::jsonb)
       returning revision,markdown,photo_ids,sources,created_at`,
      [input.account, input.dossier, latest + 1, markdown, JSON.stringify(photoIds), JSON.stringify(sources)],
    )
  ).rows[0] as TravelogueRow;
  return travelogueOf(input.dossier, row);
}

/**
 * 导出：Markdown 原样；HTML 只做最小的转义与排版（标题、加粗、链接、图片、段落、列表）。
 * 不引第三方渲染器：内容会进档案成果，越少依赖越好。
 */
export function renderExport(
  travelogue: Travelogue,
  format: "md" | "html",
  meta: { title: string; dossierId: string },
): { bytes: Buffer; mime: string; fileName: string } {
  if (format === "md")
    return {
      bytes: Buffer.from(travelogue.markdown, "utf8"),
      mime: "text/markdown; charset=UTF-8",
      fileName: `${meta.title}.md`,
    };
  const escape = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const inline = (text: string) =>
    escape(text)
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  const blocks: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of travelogue.markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flushList();
    blocks.push(`<p>${inline(line)}</p>`);
  }
  flushList();
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(meta.title)}</title>
<style>body{max-width:46rem;margin:2.5rem auto;padding:0 1.25rem;font:16px/1.75 -apple-system,"PingFang SC",sans-serif;color:#141213;background:#f0eeea}img{max-width:100%;height:auto;margin:.5rem 0}h1,h2,h3{line-height:1.3}a{color:#b45309}li{margin:.25rem 0}</style>
</head><body>
<article>${blocks.join("\n")}</article>
</body></html>
`;
  return {
    bytes: Buffer.from(html, "utf8"),
    mime: "text/html; charset=UTF-8",
    fileName: `${meta.title}.html`,
  };
}

/** 导出过一次就在档案成果里留一条（同一份修订同一格式只留一条）。 */
export async function registerTravelogueArtifact(
  client: Client,
  input: { account: string; dossier: string; revision: number; format: "md" | "html" },
): Promise<void> {
  const title = `游记 · 第 ${input.revision} 版（${input.format.toUpperCase()}）`;
  const existing = await client.query(
    "select 1 from dossier_artifact where account_id=$1 and dossier_id=$2 and kind='file' and title=$3 and removed_at is null",
    [input.account, input.dossier, title],
  );
  if (existing.rowCount) return;
  await client.query(
    `insert into dossier_artifact(id,account_id,dossier_id,kind,title,status,open)
     values(gen_random_uuid(),$1,$2,'file',$3,'available',$4::jsonb)`,
    [
      input.account,
      input.dossier,
      title,
      JSON.stringify({
        to: "file",
        path: `/v1/explore/plans/${input.dossier}/review/travelogue/export?format=${input.format}&revision=${input.revision}`,
      }),
    ],
  );
}

/** 照片在回顾里的分组依据（页面按停留点 / 计划外 / 待确认分组）。 */
export const photoGroups = (photos: Photo[]) => {
  const byStop = new Map<string, Photo[]>();
  for (const photo of photos) {
    const key = photo.placement.stopId ?? (photo.placement.basis === "unplanned" ? "__unplanned" : "__pending");
    byStop.set(key, [...(byStop.get(key) ?? []), photo]);
  }
  return byStop;
};
