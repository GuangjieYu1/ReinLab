/**
 * 两版计划书 PDF（06 §9、07 契约第 7 节与 7.1 格式规范）。
 *
 * 服务端直接排版，不渲染网页：A4 竖版、15mm 页边距、黑白为主、
 * 强调色只用莱茵橙 #FF6A00，页脚写「计划名 · 第 N 版 · 生成时间 · 页码」。
 * 地图快照来自页面导出的矢量底图（同修订），图下注来源署名。
 * 未知的规定、备选、天气一律写「未知」，不编造。
 */
import type { RefImage, Stop, WeatherHour } from "@reinlab/contracts";
import { PDFDocument, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import type { StoredPlan } from "./plan";
import type { SunDay } from "./sun";

export type BookVariant = "brief" | "full";

/** A4 与 15mm 页边距（pt）。 */
const PAGE = { width: 595.28, height: 841.89 } as const;
const MARGIN = 42.52;
const CONTENT = PAGE.width - MARGIN * 2;
const INK = rgb(0.08, 0.073, 0.074);
const FADED = rgb(0.42, 0.4, 0.4);
const RHINE_ORANGE = rgb(1, 0.416, 0);

export type SnapshotRecord = { key: string; bytes: Buffer; attribution: string };

export type BookInput = {
  dossierTitle: string;
  plan: StoredPlan;
  variant: BookVariant;
  /** overview + 每个已确认停留点各一张。 */
  snapshots: Map<string, SnapshotRecord>;
  refs: RefImage[];
  /** 参考图副本（拿不到就没有，页面上只有来源）。 */
  refImages: Map<string, Buffer>;
  weather: { byStop: { stopId: string; hours: WeatherHour[] }[]; fetchedAt: string | null } | null;
  sun: SunDay | null;
  fontBytes: Buffer;
  generatedAt: Date;
  version: number;
};

/** 这一版需要哪些快照：精简只用全程图；详细还要每个已确认停留点一张。 */
export function requiredSnapshotKeys(plan: StoredPlan, variant: BookVariant): string[] {
  const confirmed = plan.document.stops.filter((stop) => stop.state === "confirmed");
  return variant === "brief" ? ["overview"] : ["overview", ...confirmed.map((stop) => stop.id)];
}

const clock = (iso: string | null | undefined): string => {
  if (!iso) return "未知";
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match ? match[1] : iso;
};

const kindText = (kind: Stop["kind"]): string =>
  kind === "area" ? "街区" : kind === "waypoint" ? "顺路点" : "机位";

const windowText = (stop: Stop): string =>
  stop.window ? `${clock(stop.window.start)}–${clock(stop.window.end)}` : "未定";

const stampText = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** 按字符折行（中文没有空格，按宽度逐字累加）。 */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\n") {
      lines.push(current);
      current = "";
      continue;
    }
    const next = current + char;
    if (font.widthOfTextAtSize(next, size) > maxWidth && current) {
      lines.push(current);
      current = char;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

type Cursor = { page: PDFPage; y: number };

export async function buildBookPdf(input: BookInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(input.fontBytes, { subset: true });
  const title = input.dossierTitle.trim() || "旅拍计划";
  const confirmed = input.plan.document.stops.filter((stop) => stop.state === "confirmed");
  const stops = confirmed.length ? confirmed : input.plan.document.stops;
  const destination = input.plan.document.destination;
  const days = input.plan.document.days;

  const pages: PDFPage[] = [];
  const newPage = (): Cursor => {
    const page = doc.addPage([PAGE.width, PAGE.height]);
    pages.push(page);
    const cursor: Cursor = { page, y: PAGE.height - MARGIN };
    // 页脚在收尾时统一补页码。
    return cursor;
  };

  const text = (
    cursor: Cursor,
    value: string,
    options: { size?: number; color?: typeof INK; gap?: number; indent?: number } = {},
  ) => {
    const size = options.size ?? 10;
    const indent = options.indent ?? 0;
    for (const line of wrap(value, font, size, CONTENT - indent)) {
      if (cursor.y < MARGIN + 28) return false;
      cursor.y -= size + 3;
      cursor.page.drawText(line, {
        x: MARGIN + indent,
        y: cursor.y,
        size,
        font,
        color: options.color ?? INK,
      });
    }
    cursor.y -= options.gap ?? 2;
    return true;
  };

  const rule = (cursor: Cursor, color = INK, thickness = 0.6) => {
    cursor.page.drawLine({
      start: { x: MARGIN, y: cursor.y },
      end: { x: PAGE.width - MARGIN, y: cursor.y },
      thickness,
      color,
    });
    cursor.y -= 6;
  };

  const image = async (cursor: Cursor, snapshot: SnapshotRecord | undefined, maxHeight: number) => {
    if (!snapshot) {
      text(cursor, "（这一版没有对应的地图快照）", { size: 9, color: FADED });
      return;
    }
    const png = await doc.embedPng(snapshot.bytes).catch(() => null);
    if (!png) {
      text(cursor, "（地图快照读不出来）", { size: 9, color: FADED });
      return;
    }
    const scale = Math.min(CONTENT / png.width, maxHeight / png.height);
    const width = png.width * scale;
    const height = png.height * scale;
    cursor.y -= height;
    cursor.page.drawImage(png, { x: MARGIN, y: cursor.y, width, height });
    cursor.y -= 4;
    text(cursor, snapshot.attribution || "地图来源：页面导出的矢量底图", {
      size: 7.5,
      color: FADED,
    });
  };

  // ── 页头：计划名、地点、日期、拍法、模特 ──────────────────────
  const header = (cursor: Cursor) => {
    text(cursor, title, { size: 19, gap: 4 });
    rule(cursor, RHINE_ORANGE, 1.6);
    const kinds = input.plan.document.kinds
      .map((kind) => ({ portrait: "人像", landscape: "风光", travel: "旅行顺路", street: "街拍" })[kind])
      .join(" / ");
    const people = input.plan.document.people.map((person) => person.data.name).join("、");
    text(
      cursor,
      [
        destination ? `地点：${destination.name}` : "地点：未知",
        days.length ? `日期：${days.join("、")}` : "日期：未知",
        kinds ? `拍法：${kinds}` : "拍法：未知",
        people ? `模特：${people}` : "",
        `修订：第 ${input.plan.revision} 版计划`,
      ]
        .filter(Boolean)
        .join(" · "),
      { size: 9.5, color: FADED, gap: 6 },
    );
  };

  // ── 精简版：一页 ─────────────────────────────────────────────
  if (input.variant === "brief") {
    const cursor = newPage();
    header(cursor);
    await image(cursor, input.snapshots.get("overview"), 300);

    text(cursor, "时间表", { size: 12, gap: 2 });
    rule(cursor, INK, 0.4);
    const columns = [MARGIN + 2, MARGIN + 26, MARGIN + 140, MARGIN + 186, MARGIN + 246, MARGIN + 324, MARGIN + 376];
    const row = (values: string[], size = 9, color = INK) => {
      if (cursor.y < MARGIN + 60) return false;
      cursor.y -= size + 6;
      for (const [index, value] of values.entries())
        if (value) cursor.page.drawText(value, { x: columns[index], y: cursor.y, size, font, color });
      return true;
    };
    row(["#", "名称", "类型", "日期", "时段", "焦段", "要点"], 8.5, FADED);
    let shown = 0;
    for (const [index, stop] of stops.entries()) {
      const point =
        stop.detail?.composition ??
        stop.detail?.guidance?.[0] ??
        stop.reason ??
        (stop.light?.lit?.length ? "地形见光见详细版" : "光线见详细版");
      const ok = row([
        String(index + 1),
        stop.name.slice(0, 10),
        kindText(stop.kind),
        stop.day.slice(5),
        windowText(stop),
        stop.focal?.length ? `${stop.focal[0]}mm` : "—",
        point.length > 22 ? point.slice(0, 22) + "…" : point,
      ]);
      if (!ok) break;
      shown += 1;
    }
    if (shown < stops.length)
      text(cursor, `其余 ${stops.length - shown} 个停留点见详细版。`, { size: 8.5, color: FADED });

    cursor.y -= 10;
    text(cursor, "光线与天气", { size: 12, gap: 2 });
    rule(cursor, INK, 0.4);
    if (input.sun) {
      const golden = input.sun.golden
        .map((window) => `${clock(window.start)}–${clock(window.end)}`)
        .join("、");
      text(
        cursor,
        `日出 ${clock(input.sun.sunrise)} · 日落 ${clock(input.sun.sunset)} · 金色时刻 ${golden || "无"}`,
        { size: 9 },
      );
    } else text(cursor, "日出 / 日落：未知（没有地点时区）", { size: 9, color: FADED });
    const firstWeather = input.weather?.byStop.flatMap((entry) => entry.hours)[0];
    if (firstWeather)
      text(
        cursor,
        `天气（${input.weather?.fetchedAt ?? "未知"} 取）：云量 ${firstWeather.cloud ?? "未知"}% · 降水概率 ${firstWeather.precipProb ?? "未知"}% · 降水 ${firstWeather.precipMm ?? "未知"} mm/h · 风 ${firstWeather.wind ?? "未知"} m/s · ${firstWeather.temp ?? "未知"}°C`,
        { size: 9 },
      );
    else text(cursor, "天气：未知（还没有取到这份计划的预报）", { size: 9, color: FADED });

    const gear = input.plan.document.gear
      .map((item) => {
        const data = item.data as { name: string; focal?: [number, number] };
        return data.focal ? `${data.name}（${data.focal[0]}–${data.focal[1]}mm）` : data.name;
      })
      .join("、");
    text(cursor, `装备：${gear || "未知（还没有在计划里选器材）"}`, { size: 9, gap: 0 });
  } else {
    // ── 详细版：总览 + 每个停留点一页 + 末页 ────────────────────
    const overview = newPage();
    header(overview);
    await image(overview, input.snapshots.get("overview"), 250);
    const feel = input.plan.document.feel;
    text(overview, "想要的感觉", { size: 12, gap: 2 });
    rule(overview, INK, 0.4);
    if (feel?.observations?.length) {
      for (const observation of feel.observations)
        text(overview, `· ${observation.text}`, { size: 9 });
      for (const guess of feel.guesses ?? [])
        text(overview, `· 推测 · ${guess.text}`, { size: 9, color: FADED });
    } else text(overview, "未知（还没有记下参考图的感觉）", { size: 9, color: FADED });

    for (const [index, stop] of stops.entries()) {
      const cursor = newPage();
      text(cursor, `${index + 1}. ${stop.name}`, { size: 16, gap: 2 });
      rule(cursor, RHINE_ORANGE, 1.2);
      await image(cursor, input.snapshots.get(stop.id), 210);
      text(
        cursor,
        `类型：${kindText(stop.kind)} · 日期：${stop.day} · 时段：${windowText(stop)}${stop.facing !== undefined ? ` · 朝向 ${stop.facing}°` : ""}`,
        { size: 9.5, gap: 4 },
      );

      text(cursor, "光线", { size: 11, gap: 1 });
      if (stop.light?.lit?.length)
        text(cursor, `地形见光：${stop.light.lit.map((window) => `${clock(window.start)}–${clock(window.end)}`).join("、")}`, { size: 9 });
      else
        text(cursor, "地形见光：未知（没有高程数据，只有天文时段）", { size: 9, color: FADED });
      text(cursor, stop.light?.basis ? `计算依据：${stop.light.basis.dem} · 半径 ${stop.light.basis.radiusKm}km` : "计算依据：无", {
        size: 8.5,
        color: FADED,
      });

      if (stop.detail?.composition) text(cursor, `构图：${stop.detail.composition}`, { size: 9.5 });
      if (stop.focal?.length) text(cursor, `焦段：${stop.focal[0]}–${stop.focal[stop.focal.length - 1]}mm`, { size: 9.5 });
      if (stop.detail?.guidance?.length && input.plan.document.people.length)
        text(cursor, `引导词：${stop.detail.guidance.join("；")}`, { size: 9.5 });
      if (stop.detail?.outfit)
        text(
          cursor,
          `服饰：${[stop.detail.outfit.palette?.join(" / "), stop.detail.outfit.notes].filter(Boolean).join(" · ") || "未知"}`,
          { size: 9.5 },
        );

      const refs = input.refs.filter((ref) => stop.refs.includes(ref.id)).slice(0, 3);
      if (refs.length) {
        text(cursor, "参考图", { size: 11, gap: 1 });
        for (const ref of refs) {
          const bytes = input.refImages.get(ref.id);
          const png = bytes ? await doc.embedPng(bytes).catch(() => null) : null;
          if (png) {
            const scale = Math.min(110 / png.width, 110 / png.height);
            cursor.y -= png.height * scale;
            cursor.page.drawImage(png, {
              x: MARGIN,
              y: cursor.y,
              width: png.width * scale,
              height: png.height * scale,
            });
            cursor.y -= 2;
          }
          text(
            cursor,
            `[${ref.kind === "same-spot" ? "该机位实拍" : "风格参考"}] ${ref.author ?? "作者未知"} · ${ref.platform ?? "平台未知"} · ${ref.page?.url ?? "无原网页"}${png ? "" : " · 没拿到图，只有来源"}`,
            { size: 7.5, color: FADED, gap: 3 },
          );
        }
      }

      if (Array.isArray(stop.detail?.rules) && stop.detail.rules.length)
        text(
          cursor,
          `规定：${stop.detail.rules.map((entry) => entry.text + (entry.source?.name ? `（${entry.source.name}）` : "")).join("；")}`,
          { size: 9.5 },
        );
      else text(cursor, "规定：未知", { size: 9.5, color: FADED });
      text(cursor, `雨天备选：${stop.detail?.fallback ?? "未知"}`, { size: 9.5 });
    }

    const last = newPage();
    text(last, "天气预案 · 装备 · 来源", { size: 15, gap: 2 });
    rule(last, RHINE_ORANGE, 1.2);
    text(last, `预报获取时间：${input.weather?.fetchedAt ?? "未知"}`, { size: 9, color: FADED, gap: 4 });
    for (const [index, stop] of stops.entries()) {
      const hours = input.weather?.byStop.find((entry) => entry.stopId === stop.id)?.hours ?? [];
      const slice = hours.slice(0, 4);
      text(
        last,
        `${index + 1}. ${stop.name}（${windowText(stop)}）：${
          slice.length
            ? slice
                .map(
                  (hour) =>
                    `${clock(hour.at)} 云${hour.cloud ?? "未知"}% 降水${hour.precipProb ?? "未知"}%/${hour.precipMm ?? "未知"}mm 风${hour.wind ?? "未知"}m/s ${hour.temp ?? "未知"}°C`,
                )
                .join("；")
            : "未知（没有这份计划的预报）"
        }`,
        { size: 8.5 },
      );
    }
    const gear = input.plan.document.gear.map((item) => {
      const data = item.data as { name: string; focal?: [number, number] };
      return data.focal ? `${data.name}（${data.focal[0]}–${data.focal[1]}mm）` : data.name;
    });
    text(last, `装备：${gear.length ? gear.join("、") : "未知"}`, { size: 9.5, gap: 4 });
    text(last, "参考来源", { size: 11, gap: 1 });
    if (!input.refs.length) text(last, "无", { size: 9, color: FADED });
    for (const ref of input.refs)
      text(
        last,
        `· ${ref.page?.url ?? "无原网页"}${ref.author ? " · " + ref.author : ""}${ref.platform ? " · " + ref.platform : ""}${ref.image ? "" : "（没拿到图，只有来源）"}`,
        { size: 8.5 },
      );
  }

  // ── 页脚：计划名 · 第 N 版 · 生成时间 · 页码 ──────────────────
  pages.forEach((page, index) => {
    const footer = `${title} · 第 ${input.version} 版 · ${stampText(input.generatedAt)} · ${index + 1}/${pages.length}`;
    page.drawLine({
      start: { x: MARGIN, y: MARGIN - 8 },
      end: { x: PAGE.width - MARGIN, y: MARGIN - 8 },
      thickness: 0.4,
      color: FADED,
    });
    page.drawText(footer, { x: MARGIN, y: MARGIN - 20, size: 7.5, font, color: FADED });
  });

  return doc.save();
}

/** 给页面用的素材清单：这一版还缺哪几张快照。 */
export function missingSnapshots(
  plan: StoredPlan,
  variant: BookVariant,
  available: Set<string>,
): string[] {
  return requiredSnapshotKeys(plan, variant).filter((key) => !available.has(key));
}

/** 详细版每页最多容纳的参考图（契约：最多 3 张）。 */
export const MAX_REFS_PER_STOP = 3;
