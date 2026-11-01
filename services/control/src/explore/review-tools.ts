/**
 * 回顾工具（给对话里的助手用；design/prd/09-explore-v2.md §6、§9）。
 *
 * 助手自己决定看什么、看几眼：先列组、看联系表、再看细节，最后标推荐/备选。
 * 几条硬规矩：
 * - 看图是真调用：按峰值费率估一次成本，超出账户本月可用额度就拒绝，不偷偷花；
 * - 用量按真实 token 记账，token 拿不到就记未知（不记 0）；
 * - AI 推荐与用户精选分开存；看过哪一档（联系表 / 预览 / 局部）照实写在 ai.inspected，
 *   没细看过的不允许说成「逐张看过」；
 * - 对照、游记、经验都只用真实数据；「没找到证据」不等于没去。
 */
import type pg from "pg";
import sharp from "sharp";
import type { ExperienceProposal, LngLat } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { monthlyBudgetSnapshot } from "../budget";
import { recordSpend } from "../budget/spend";
import { recordUsage } from "../run/usage";
import { requestApproval } from "../run/approval";
import { listFieldEvents } from "./field";
import { loadPlan, stopCenter } from "./service";
import { countPhotos, markPhotos, photoRow, listPhotos, type PhotoRow } from "./photos";
import { cameraGroups } from "./clock";
import { buildComparison, latestTravelogue, saveTravelogue } from "./review";
import type { PhotoStore } from "./photo-store";
import type { PhotoReader } from "./photo-reader";

type Client = pg.PoolClient;

export type ReviewToolDeps = {
  store?: PhotoStore;
  reader?: PhotoReader;
  /** 计价：每百万 token 的人民币价（峰值费率）。没有就只记用量不估价。 */
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  publish?: (account: string, event: Record<string, unknown>) => void;
};

const TOOL_NAMES = new Set([
  "photos",
  "photo_contact_sheet",
  "photo_view",
  "photo_mark",
  "field_events",
  "compare",
  "travelogue",
  "experience",
]);

export const REVIEW_TOOLS = [...TOOL_NAMES];

const ids = (value: unknown, max = 20): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && /^[0-9a-f-]{36}$/i.test(item)))].slice(0, max)
    : [];

const statsOf = (row: PhotoRow): Record<string, unknown> => {
  const stats = (row.stats ?? {}) as Record<string, unknown>;
  return {
    width: stats.width ?? null,
    height: stats.height ?? null,
    brightness: stats.brightness ?? null,
    contrast: stats.contrast ?? null,
    sharpness: stats.sharpness ?? null,
    ...(typeof stats.note === "string" ? { note: stats.note } : {}),
  };
};

const photoBrief = (row: PhotoRow) => ({
  id: row.id,
  file: row.file_name,
  time: row.corrected_ts ? new Date(row.corrected_ts).toISOString() : null,
  timeTrust: row.time_trust,
  placement: { stopId: row.placement_stop_id, basis: row.placement_basis },
  ai: { mark: row.ai_mark, inspected: row.ai_inspected, ...(row.ai_reason ? { reason: row.ai_reason } : {}) },
  picked: row.picked,
  stats: statsOf(row),
});

/** 一次看图预估花多少：按峰值费率保守估，超预算就拒绝。 */
function estimateCny(images: number, deps: ReviewToolDeps): number | null {
  if (!deps.pricing) return null;
  // 一张 1600px 预览大约 1200–1600 输入 token；输出最多 1600。
  const inputTokens = images * 1600 + 800;
  return (inputTokens * deps.pricing.inputPerMillion + 1600 * deps.pricing.outputPerMillion) / 1_000_000;
}

async function guardBudget(client: Client, images: number, deps: ReviewToolDeps) {
  const estimate = estimateCny(images, deps);
  if (estimate === null) return;
  const snapshot = await monthlyBudgetSnapshot(client);
  const available = Number(snapshot.availableCny);
  if (Number.isFinite(available) && estimate > available)
    throw new ApiFailure(
      "REVIEW_BUDGET_EXCEEDED",
      409,
      `本月可用额度只剩 ¥${available.toFixed(2)}，这次看图预估要 ¥${estimate.toFixed(3)}；先不要继续看片，或调小范围。`,
    );
}

async function recordVision(
  client: Client,
  input: { account: string; dossier: string; run: string; model: string; inputTokens: number | null; outputTokens: number | null },
  deps: ReviewToolDeps,
) {
  const known = Number.isSafeInteger(input.inputTokens) && Number.isSafeInteger(input.outputTokens);
  const cost =
    known && deps.pricing
      ? ((input.inputTokens! * deps.pricing.inputPerMillion + input.outputTokens! * deps.pricing.outputPerMillion) /
          1_000_000
        ).toFixed(6)
      : null;
  await recordUsage(client, {
    account: input.account,
    dossier: input.dossier,
    run: input.run,
    purpose: "vision",
    provider: "deepseek-official",
    model: input.model,
    known,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    costCny: cost,
  });
  // 花了就记到这份档案本月的账上：可用额度会真的变少，下一次看图才会被拦。
  await recordSpend(client, { account: input.account, dossier: input.dossier, costCny: cost }).catch(
    () => undefined,
  );
}

async function loadRows(
  client: Client,
  input: { account: string; dossier: string; args: Record<string, unknown> },
  limit: number,
): Promise<PhotoRow[]> {
  const wanted = ids(input.args.photoIds, limit);
  if (wanted.length) {
    const rows: PhotoRow[] = [];
    for (const id of wanted) rows.push(await photoRow(client, input.account, input.dossier, id));
    return rows.filter((row) => row.status === "ready");
  }
  const listed = await listPhotos(client, {
    account: input.account,
    dossier: input.dossier,
    ...(typeof input.args.stopId === "string" ? { stopId: input.args.stopId } : {}),
    ...(typeof input.args.group === "string" ? { group: input.args.group } : {}),
    limit,
  });
  return (
    await Promise.all(
      listed.items.map((item) => photoRow(client, input.account, input.dossier, item.id).catch(() => null)),
    )
  ).filter((row): row is PhotoRow => Boolean(row) && row!.status === "ready");
}

/** 联系表：把一组照片拼成一张图看一遍（便宜、粗糙；细节不够就再看单张）。 */
async function contactSheet(store: PhotoStore, dossier: string, rows: PhotoRow[]): Promise<Buffer | null> {
  const TILE = 320;
  const COLS = 4;
  const thumbs: Buffer[] = [];
  for (const row of rows) {
    const bytes = await store.read(dossier, row.id, "thumb.jpg");
    if (bytes) thumbs.push(bytes);
  }
  if (!thumbs.length) return null;
  const tiles = await Promise.all(
    thumbs.map((bytes) => sharp(bytes).resize(TILE, TILE, { fit: "cover" }).jpeg({ quality: 80 }).toBuffer()),
  );
  const lines = Math.ceil(tiles.length / COLS);
  return sharp({
    create: { width: COLS * TILE, height: lines * TILE, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite(tiles.map((input, index) => ({ input, left: (index % COLS) * TILE, top: Math.floor(index / COLS) * TILE })))
    .jpeg({ quality: 82 })
    .toBuffer();
}

/**
 * 回顾工具入口。和 explore 其它工具一样返回 {status, body:{result}}；
 * 页面按 result 里的 photoIds / comparison / travelogueId / pending 出卡。
 */
export async function reviewTool(
  client: Client,
  input: { account: string; dossier: string; run: string; tool: string; args: Record<string, unknown> },
  deps: ReviewToolDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const args = input.args ?? {};
  if (!TOOL_NAMES.has(input.tool))
    throw new ApiFailure("KERNEL_TOOL_DENIED", 403, "这个回顾工具不存在。");
  const { plan } = await loadPlan(client, input.account, input.dossier);

  if (input.tool === "photos") {
    const listed = await listPhotos(client, {
      account: input.account,
      dossier: input.dossier,
      ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
      ...(typeof args.stopId === "string" ? { stopId: args.stopId } : {}),
      ...(typeof args.group === "string" ? { group: args.group } : {}),
      limit: Math.min(120, Math.max(1, Number(args.limit) || 60)),
    });
    const total = await countPhotos(client, {
      account: input.account,
      dossier: input.dossier,
      ...(typeof args.stopId === "string" ? { stopId: args.stopId } : {}),
      ...(typeof args.group === "string" ? { group: args.group } : {}),
    });
    // 这一页之后还剩多少张：拿游标位置数，别把「这一页之外」和「后面还没看的」混成一个数。
    const remaining = listed.cursor
      ? await countPhotos(client, {
          account: input.account,
          dossier: input.dossier,
          ...(typeof args.stopId === "string" ? { stopId: args.stopId } : {}),
          ...(typeof args.group === "string" ? { group: args.group } : {}),
          after: listed.cursor,
        })
      : 0;
    const rows: PhotoRow[] = [];
    for (const item of listed.items) rows.push(await photoRow(client, input.account, input.dossier, item.id));
    const groups = await cameraGroups(client, {
      account: input.account,
      dossier: input.dossier,
      document: plan.document,
    });
    return {
      status: 200,
      body: {
        result: {
          items: rows.map(photoBrief),
          photoIds: rows.map((row) => row.id),
          cursor: listed.cursor,
          total,
          returned: listed.items.length,
          hasMore: Boolean(listed.cursor),
          remaining,
          // 对时状态先看一眼：时间不准的时候，落位与对照都不该说得太死。
          clock: groups.map((group) => ({ id: group.id, label: group.label, status: group.status, offsetSec: group.offsetSec })),
          note: listed.cursor
            ? `后面还有 ${remaining} 张没列出来（这一页 ${listed.items.length} 张，共 ${total} 张）：要接着看就把 cursor 原样传回来翻页；没列出来的那些你没看过，别说成「全部看完了」。`
            : "列表只给统计和落位依据；要看清楚对焦/曝光，得用 photo_contact_sheet 或 photo_view。",
        },
      },
    };
  }

  if (input.tool === "field_events") {
    const events = await listFieldEvents(client, {
      account: input.account,
      dossier: input.dossier,
      document: plan.document,
    });
    return {
      status: 200,
      body: {
        result: {
          items: events.map((event) => ({
            clientId: event.clientId,
            kind: event.kind,
            at: event.at,
            stopId: event.stopId,
            stopName: event.stopName,
            status: event.status,
            ...(event.effectiveText ?? event.text ? { text: event.effectiveText ?? event.text } : {}),
            ...(event.situation ? { situation: event.situation } : {}),
            ...(event.position ? { position: event.position } : {}),
          })),
          note: "打卡可能晚于快门，也可能只是路过；写时间时别把它当成拍摄时刻。",
        },
      },
    };
  }

  if (input.tool === "photo_contact_sheet") {
    if (!deps.store) throw new ApiFailure("STORAGE_UNAVAILABLE", 503, "照片目录没准备好。");
    const rows = await loadRows(client, { ...input, args }, 20);
    if (!rows.length) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "这组里没有能看的照片。");
    const sheet = await contactSheet(deps.store, input.dossier, rows);
    if (!sheet) throw new ApiFailure("PHOTO_MEDIA_MISSING", 404, "缩略图还没生成好。");
    if (!deps.reader)
      throw new ApiFailure("REVIEW_READER_UNAVAILABLE", 503, "读图的模型通道没配置，看不了片子。");
    await guardBudget(client, 1, deps);
    const legend = rows
      .map((row, index) => `${index + 1}. id=${row.id}｜${row.file_name}｜${row.corrected_ts ? new Date(row.corrected_ts).toISOString().slice(11, 16) : "时间未知"}`)
      .join("\n");
    const viewed = await deps.reader({
      images: [
        {
          photoId: rows[0].id,
          data: sheet.toString("base64"),
          mimeType: "image/jpeg",
          label: "联系表（左到右、上到下依次是下面这些）",
        },
      ],
      ask: `这是一张联系表，每格按顺序对应下面的一张照片。请按 photoId 逐个给结论（看不清就说 uncertain）：\n${legend}`,
    });
    await recordVision(
      client,
      {
        account: input.account,
        dossier: input.dossier,
        run: input.run,
        model: viewed.usage.model,
        inputTokens: viewed.usage.inputTokens,
        outputTokens: viewed.usage.outputTokens,
      },
      deps,
    );
    // 看过联系表只算「预览过」，不算逐张细看。
    await markPhotos(client, {
      account: input.account,
      dossier: input.dossier,
      photoIds: rows.map((row) => row.id),
      mark: null,
      inspected: "preview",
    });
    deps.publish?.(input.account, { type: "explore.review", dossierId: input.dossier, part: "picks" });
    return {
      status: 200,
      body: {
        result: {
          photoIds: rows.map((row) => row.id),
          observations: viewed.observations,
          summary: viewed.summary,
          note: "联系表是缩略图拼的：能看出大致对焦/曝光，但看不清闭眼、细节纹理。要确认就再看单张。",
        },
      },
    };
  }

  if (input.tool === "photo_view") {
    if (!deps.store) throw new ApiFailure("STORAGE_UNAVAILABLE", 503, "照片目录没准备好。");
    if (!deps.reader) throw new ApiFailure("REVIEW_READER_UNAVAILABLE", 503, "读图的模型通道没配置，看不了片子。");
    const rows = await loadRows(client, { ...input, args }, 4);
    if (!rows.length) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "没找到这张照片。");
    const region = args.region as { x?: number; y?: number; w?: number; h?: number } | undefined;
    const detail = Boolean(region);
    const images: { photoId: string; data: string; mimeType: string; label?: string }[] = [];
    for (const row of rows) {
      let bytes: Buffer | null = null;
      if (detail) {
        const rect = {
          x: Math.min(0.99, Math.max(0, Number(region?.x ?? 0))),
          y: Math.min(0.99, Math.max(0, Number(region?.y ?? 0))),
          w: Math.min(1, Math.max(0.05, Number(region?.w ?? 0.5))),
          h: Math.min(1, Math.max(0.05, Number(region?.h ?? 0.5))),
        };
        const { cropOf } = await import("./photos");
        bytes = await cropOf(deps.store.originalPath(input.dossier, row.id), rect).catch(() => null);
      }
      bytes ??= await deps.store.read(input.dossier, row.id, "preview.jpg");
      if (!bytes) continue;
      images.push({
        photoId: row.id,
        data: bytes.toString("base64"),
        mimeType: "image/jpeg",
        label: `${row.file_name}${row.corrected_ts ? ` · ${new Date(row.corrected_ts).toISOString().slice(11, 16)}` : ""}${detail ? " · 局部" : ""}`,
      });
    }
    if (!images.length) throw new ApiFailure("PHOTO_MEDIA_MISSING", 404, "这张照片的图还没生成好。");
    await guardBudget(client, images.length, deps);
    const viewed = await deps.reader({ images, ask: typeof args.ask === "string" ? args.ask : undefined });
    await recordVision(
      client,
      {
        account: input.account,
        dossier: input.dossier,
        run: input.run,
        model: viewed.usage.model,
        inputTokens: viewed.usage.inputTokens,
        outputTokens: viewed.usage.outputTokens,
      },
      deps,
    );
    await markPhotos(client, {
      account: input.account,
      dossier: input.dossier,
      photoIds: images.map((image) => image.photoId),
      mark: null,
      inspected: detail ? "detail" : "preview",
    });
    deps.publish?.(input.account, { type: "explore.review", dossierId: input.dossier, part: "picks" });
    return {
      status: 200,
      body: {
        result: {
          photoIds: images.map((image) => image.photoId),
          observations: viewed.observations,
          summary: viewed.summary,
          inspected: detail ? "detail" : "preview",
          note: detail
            ? "看的是原图局部裁切，细节可以据此下结论。"
            : "看的是 1600px 预览，眯眼/极小细节可能看不清；需要就再看局部。",
        },
      },
    };
  }

  if (input.tool === "photo_mark") {
    const wanted = ids(args.photoIds, 100);
    const mark = args.mark === "recommend" || args.mark === "alternate" ? args.mark : null;
    const inspected =
      args.inspected === "detail" ? "detail" : args.inspected === "preview" ? "preview" : undefined;
    // 只能标自己真看过的那一档：说要「细看过」但还没看过局部，就降成预览。
    const rows: PhotoRow[] = [];
    for (const id of wanted) rows.push(await photoRow(client, input.account, input.dossier, id));
    const honest = inspected === "detail" && rows.some((row) => row.ai_inspected !== "detail") ? "preview" : inspected;
    const changed = await markPhotos(client, {
      account: input.account,
      dossier: input.dossier,
      photoIds: wanted,
      mark,
      ...(typeof args.reason === "string" ? { reason: args.reason.slice(0, 300) } : {}),
      ...(honest ? { inspected: honest } : {}),
    });
    deps.publish?.(input.account, { type: "explore.review", dossierId: input.dossier, part: "picks" });
    return {
      status: 200,
      body: {
        result: {
          photoIds: wanted,
          changed,
          note: "这是 AI 推荐，用户在页面上可以接受或换成别的；精选由用户自己定。",
        },
      },
    };
  }

  if (input.tool === "compare") {
    const revision = Number(args.revision);
    const comparison = await buildComparison(client, {
      account: input.account,
      dossier: input.dossier,
      revision: Number.isInteger(revision) && revision > 0 ? revision : plan.revision,
      document: plan.document,
    });
    deps.publish?.(input.account, { type: "explore.review", dossierId: input.dossier, part: "comparison" });
    return {
      status: 200,
      body: {
        result: {
          comparison: true,
          ...comparison,
          note: "none_found 只是没找到拍摄证据，不等于没去；lateMin 为 null 表示对时不准，别自己算。",
        },
      },
    };
  }

  if (input.tool === "travelogue") {
    const markdown = String(args.markdown ?? "");
    if (!markdown.trim()) throw new ApiFailure("INVALID_INPUT", 400, "游记正文是空的。");
    const latest = await latestTravelogue(client, input.account, input.dossier);
    const baseRevision = Number(args.baseRevision);
    const travelogue = await saveTravelogue(client, {
      account: input.account,
      dossier: input.dossier,
      baseRevision: Number.isInteger(baseRevision) && baseRevision >= 0 ? baseRevision : (latest?.revision ?? 0),
      markdown,
    });
    deps.publish?.(input.account, { type: "explore.review", dossierId: input.dossier, part: "travelogue" });
    return {
      status: 200,
      body: {
        result: {
          travelogueId: travelogue.id,
          revision: travelogue.revision,
          photoIds: travelogue.photoIds,
          note: "草稿已存成新的一版；用户可以在页面上改。没有素材的地方不要补。",
        },
      },
    };
  }

  // experience：只出提案，用户确认之后才写进资料。
  const target = args.target === "model" ? "model" : "place";
  const title = String(args.title ?? "").trim().slice(0, 120);
  const bodyText = String(args.text ?? "").trim();
  if (!title || !bodyText) throw new ApiFailure("INVALID_INPUT", 400, "经验提案要有标题和正文。");
  const evidenceRaw = (args.evidence ?? {}) as Record<string, unknown>;
  const evidence = {
    ...(ids(evidenceRaw.photoIds, 100).length ? { photoIds: ids(evidenceRaw.photoIds, 100) } : {}),
    ...(Array.isArray(evidenceRaw.eventIds)
      ? { eventIds: evidenceRaw.eventIds.filter((item): item is string => typeof item === "string").slice(0, 100) }
      : {}),
    dossierId: input.dossier,
  };
  const payload: Record<string, unknown> =
    target === "place"
      ? {
          type: "place",
          name: String(args.name ?? title).slice(0, 80),
          at: Array.isArray(args.at) && args.at.length === 2 ? (args.at as LngLat) : stopCenter(plan.document.stops[0]?.geometry ?? { type: "Point", coordinates: [0, 0] }),
          radiusM: Number(args.radiusM) > 0 ? Number(args.radiusM) : 300,
          observedOn:
            typeof args.observedOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.observedOn)
              ? args.observedOn
              : (plan.document.days[0] ?? new Date().toISOString().slice(0, 10)),
          text: bodyText.slice(0, 4000),
          evidence,
          ...(typeof args.standpoint === "string" ? { standpoint: args.standpoint.slice(0, 200) } : {}),
          ...(typeof args.season === "string" ? { season: args.season.slice(0, 20) } : {}),
          ...(typeof args.timeOfDay === "string" ? { timeOfDay: args.timeOfDay.slice(0, 40) } : {}),
        }
      : { text: bodyText.slice(0, 4000), evidence };

  const card = await requestApproval(client, {
    account: input.account,
    dossier: input.dossier,
    run: input.run,
    capability: "explore.experience",
    argsHash: JSON.stringify({ target, title, ...payload }).slice(0, 4000),
    title: `记下这条${target === "place" ? "地点" : "模特"}经验：${title}`,
    effects: [
      {
        kind: "explore.experience",
        dossierId: input.dossier,
        target,
        ...(typeof args.profileId === "string" ? { profileId: args.profileId } : {}),
        title,
        payload,
        summary: `${title}：${bodyText.slice(0, 120)}`,
      },
    ],
    risk: "write",
  });
  const proposal: ExperienceProposal = {
    approvalId: card.id,
    target,
    ...(typeof args.profileId === "string" ? { profileId: args.profileId } : {}),
    title,
    text: bodyText.slice(0, 4000),
    evidence,
    summary: `${title}：${bodyText.slice(0, 120)}`,
  };
  return {
    status: 200,
    body: { result: { pending: { kind: "experience", ...proposal } } },
  };
}
