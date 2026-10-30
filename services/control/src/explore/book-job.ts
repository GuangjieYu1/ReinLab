/**
 * 地图快照与两版计划书的生成（07 契约第 3 节其他写接口、第 7 节）。
 *
 * 快照按「修订 + 键」保存；生成 PDF 时只认同修订的快照，旧图不混装新计划。
 * 生成在 202 之后异步进行，成功作为档案成果出现并推 explore.book。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type pg from "pg";
import type { WeatherHour } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { announceDossierChanged } from "../dossier/service";
import { buildBookPdf, missingSnapshots, type BookVariant, type SnapshotRecord } from "./books";
import { loadPlan } from "./service";
import { listRefs, type ExploreStorage } from "./refs";
import { sunDay } from "./sun";

type Client = pg.PoolClient;

export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** 默认字体：Noto Sans SC（开源黑体，SIL OFL）。可由配置覆盖。 */
export function defaultFontFile(): string {
  return path.join(homedir(), ".local/state/reinlab/fonts/NotoSansSC-VF.ttf");
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 存一张地图快照（同一修订同一键覆盖）。 */
export async function saveSnapshot(
  client: Client,
  storage: ExploreStorage,
  input: {
    account: string;
    dossier: string;
    revision: number;
    key: string;
    bytes: Buffer;
    attribution?: string | null;
    basemap?: string | null;
  },
): Promise<{ key: string; revision: number; bytes: number }> {
  const { plan } = await loadPlan(client, input.account, input.dossier);
  if (input.revision !== plan.revision)
    throw new ApiFailure("REVISION_CONFLICT", 409, "计划刚改过，重新导出这一版的快照。", {
      revision: plan.revision,
    });
  if (input.basemap && input.basemap !== "vector")
    throw new ApiFailure("SNAPSHOT_BASEMAP_INVALID", 400, "计划书只用矢量底图的快照。");
  const key = input.key === "overview" ? "overview" : input.key;
  if (key !== "overview") {
    const stop = plan.document.stops.find((row) => row.id === key);
    if (!stop) throw new ApiFailure("SNAPSHOT_KEY_INVALID", 400, "这张快照要对应计划里的一个停留点。");
    if (stop.state !== "confirmed")
      throw new ApiFailure("SNAPSHOT_KEY_INVALID", 400, "只给已确认的停留点导局部图。");
  }
  if (!input.bytes.length || !input.bytes.subarray(0, 8).equals(PNG_MAGIC))
    throw new ApiFailure("SNAPSHOT_NOT_PNG", 400, "地图快照要 PNG。");
  if (input.bytes.length > SNAPSHOT_MAX_BYTES)
    throw new ApiFailure("SNAPSHOT_TOO_LARGE", 413, "地图快照太大了，换一张小一点的。");
  const stored = await storage.saveSnapshot({
    dossier: input.dossier,
    revision: input.revision,
    key,
    bytes: input.bytes,
  });
  await client.query(
    `insert into explore_snapshot(account_id,dossier_id,revision,key,path,mime,attribution,bytes)
     values($1,$2,$3,$4,$5,'image/png',$6,$7)
     on conflict (account_id,dossier_id,revision,key) do update set
       path=excluded.path, attribution=excluded.attribution, bytes=excluded.bytes, created_at=now()`,
    [input.account, input.dossier, input.revision, key, stored, input.attribution ?? null, input.bytes.length],
  );
  return { key, revision: input.revision, bytes: input.bytes.length };
}

export type BookPlan = {
  artifactId: string;
  version: number;
  variant: BookVariant;
  revision: number;
};

/**
 * 请求生成：校验修订与本修订所需快照。缺图返回 409 + 缺哪几个键（页面据此补导）。
 * 通过之后由调用方异步生成。
 */
export async function prepareBook(
  client: Client,
  input: { account: string; dossier: string; variant: BookVariant; revision: number },
): Promise<BookPlan> {
  const { plan, bench } = await loadPlan(client, input.account, input.dossier);
  if (bench !== "exploration") throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有探索档案有计划书。");
  if (input.revision !== plan.revision)
    throw new ApiFailure("REVISION_CONFLICT", 409, "计划刚改过，按最新修订重新生成。", {
      revision: plan.revision,
    });
  const available = new Set(
    (
      await client.query(
        "select key from explore_snapshot where account_id=$1 and dossier_id=$2 and revision=$3",
        [input.account, input.dossier, input.revision],
      )
    ).rows.map((row) => String(row.key)),
  );
  const missing = missingSnapshots(plan, input.variant, available);
  if (missing.length)
    throw new ApiFailure("NEEDS_MAP_SNAPSHOTS", 409, "这一版还缺地图快照，先在页面上导出。", {
      keys: missing,
      revision: input.revision,
    });
  const version =
    Number(
      (
        await client.query(
          `select count(*)::int n from dossier_artifact
            where account_id=$1 and dossier_id=$2 and kind='file' and title like '%· 第 %版'`,
          [input.account, input.dossier],
        )
      ).rows[0]?.n ?? 0,
    ) + 1;
  return { artifactId: randomUUID(), version, variant: input.variant, revision: input.revision };
}

const clock = (iso: string): string => {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? match[1] : iso;
};

/** 真正生成：读素材 → 排版 → 存文件 → 记成果 → 推事件。自己开事务。 */
export async function generateBook(
  deps: {
    db: import("../db/database").Database;
    storage: ExploreStorage;
    fontFile?: string;
    publish?: (account: string, event: Record<string, unknown>) => void;
  },
  input: { account: string; dossier: string; plan: BookPlan },
): Promise<void> {
  const { db, storage } = deps;
  try {
    const fontFile = deps.fontFile ?? defaultFontFile();
    const fontBytes = await readFile(fontFile).catch(() => null);
    if (!fontBytes)
      throw new ApiFailure(
        "BOOK_FONT_UNAVAILABLE",
        503,
        `中文 PDF 需要一份开源黑体字体文件，当前路径没有：${fontFile}`,
      );

    const material = await db.withAccount(input.account, async (client) => {
      const { plan } = await loadPlan(client, input.account, input.dossier);
      const dossier = (
        await client.query("select title from dossier where account_id=$1 and id=$2", [
          input.account,
          input.dossier,
        ])
      ).rows[0];
      const rows = (
        await client.query(
          "select key,path,attribution from explore_snapshot where account_id=$1 and dossier_id=$2 and revision=$3",
          [input.account, input.dossier, input.plan.revision],
        )
      ).rows;
      const weatherRows = (
        await client.query(
          "select key,hours,fetched_at from explore_weather where account_id=$1 and dossier_id=$2",
          [input.account, input.dossier],
        )
      ).rows;
      const refs = await listRefs(client, input.account, input.dossier);
      const refPaths = new Map<string, string>(
        (
          await client.query(
            "select id,image_path from explore_ref where account_id=$1 and dossier_id=$2 and removed_at is null and image_path is not null",
            [input.account, input.dossier],
          )
        ).rows.map((row) => [String(row.id), String(row.image_path)]),
      );
      return {
        plan,
        title: String(dossier?.title ?? "旅拍计划"),
        snapshots: rows.map((row) => ({ key: String(row.key), path: String(row.path), attribution: String(row.attribution ?? "") })),
        byStop: weatherRows
          .filter((row) => row.key !== "destination")
          .map((row) => ({ stopId: String(row.key), hours: (row.hours ?? []) as WeatherHour[] })),
        fetchedAt: weatherRows
          .map((row) => (row.fetched_at ? new Date(row.fetched_at).toISOString() : null))
          .filter(Boolean)
          .sort()
          .pop() ?? null,
        refs,
        refPaths,
      };
    });

    // 图片字节在事务外读，别占着数据库连接。
    const snapshots = new Map<string, SnapshotRecord>();
    for (const row of material.snapshots) {
      const file = await storage.readSnapshot({ dossier: input.dossier, path: row.path });
      if (file) snapshots.set(row.key, { key: row.key, bytes: file.bytes, attribution: row.attribution });
    }
    const refImages = new Map<string, Buffer>();
    for (const [id, relative] of material.refPaths) {
      const file = await storage.readRef({ dossier: input.dossier, path: relative });
      if (file && file.bytes.length <= SNAPSHOT_MAX_BYTES) refImages.set(id, file.bytes);
    }

    const destination = material.plan.document.destination;
    const day = material.plan.document.days[0];
    const sun = destination && day ? sunDay(destination.center, day, destination.timezone) : null;

    const bytes = await buildBookPdf({
      dossierTitle: material.title,
      plan: material.plan,
      variant: input.plan.variant,
      snapshots,
      refs: material.refs,
      refImages,
      weather: { byStop: material.byStop, fetchedAt: material.fetchedAt },
      sun,
      fontBytes,
      generatedAt: new Date(),
      version: input.plan.version,
    });

    await storage.saveBook({ dossier: input.dossier, artifactId: input.plan.artifactId, bytes: Buffer.from(bytes) });

    const title = `${input.plan.variant === "brief" ? "精简" : "详细"} · 第 ${input.plan.version} 版`;
    await db.withAccount(input.account, async (client) => {
      await client.query(
        `insert into dossier_artifact(id,account_id,dossier_id,kind,title,status,open)
         values($1,$2,$3,'file',$4,'available',$5::jsonb)`,
        [
          input.plan.artifactId,
          input.account,
          input.dossier,
          title,
          JSON.stringify({
            to: "file",
            path: `/v1/explore/plans/${input.dossier}/books/${input.plan.artifactId}/file`,
          }),
        ],
      );
      await client.query(
        "update dossier set last_activity_at=now(), version=version+1 where account_id=$1 and id=$2",
        [input.account, input.dossier],
      );
      await client.query(
        `insert into event(account_id,dossier_id,kind,action,payload,dedupe_key)
         values($1,$2,'user_op','attach',$3,$4) on conflict do nothing`,
        [
          input.account,
          input.dossier,
          JSON.stringify({
            id: randomUUID(),
            at: new Date().toISOString(),
            dossierId: input.dossier,
            actor: "agent",
            via: "agent",
            action: "attach",
            text: `助手生成了《${title}》`,
          }),
          "explore-book:" + input.plan.artifactId,
        ],
      );
      await announceDossierChanged(client, input.account, input.dossier, "artifacts").catch(() => {});
    });

    deps.publish?.(input.account, {
      type: "explore.book",
      dossierId: input.dossier,
      jobId: input.plan.artifactId,
      state: "done",
      artifactId: input.plan.artifactId,
      url: `/v1/explore/plans/${input.dossier}/books/${input.plan.artifactId}/file`,
    });
  } catch (error) {
    const message = String((error as Error)?.message ?? error).slice(0, 240);
    deps.publish?.(input.account, {
      type: "explore.book",
      dossierId: input.dossier,
      jobId: input.plan.artifactId,
      state: "failed",
      message,
    });
    // 生成失败要留痕，但不要把它当成用户看到的成果。
    console.error(
      JSON.stringify({ code: "EXPLORE_BOOK_FAILED", dossier: input.dossier, message: message.slice(0, 200) }),
    );
  }
}

/** 打开一份已生成计划书（只给本账户本档案）。 */
export async function readBook(
  client: Client,
  storage: ExploreStorage,
  input: { account: string; dossier: string; artifactId: string },
): Promise<{ bytes: Buffer; mime: string; title: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.artifactId))
    throw new ApiFailure("BOOK_NOT_FOUND", 404, "找不到这份计划书。");
  const row = (
    await client.query(
      `select title from dossier_artifact
        where account_id=$1 and dossier_id=$2 and id=$3 and kind='file' and removed_at is null`,
      [input.account, input.dossier, input.artifactId],
    )
  ).rows[0];
  if (!row) throw new ApiFailure("BOOK_NOT_FOUND", 404, "找不到这份计划书。");
  const file = await storage.readBook({
    dossier: input.dossier,
    path: `${input.artifactId}.pdf`,
  });
  if (!file) throw new ApiFailure("BOOK_FILE_MISSING", 410, "这份计划书的文件已经不在磁盘上了。");
  return { bytes: file.bytes, mime: "application/pdf", title: String(row.title) };
}

/** 已保存的快照键（页面补导时对照用）。 */
export async function snapshotKeys(client: Client, account: string, dossier: string, revision: number): Promise<string[]> {
  return (
    await client.query(
      "select key from explore_snapshot where account_id=$1 and dossier_id=$2 and revision=$3",
      [account, dossier, revision],
    )
  ).rows.map((row) => String(row.key));
}

