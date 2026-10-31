/**
 * 探索台计划与画布的纯引擎（design/prd/07-explore-contract.md 第 1、3、4 节）。
 *
 * 这里不碰数据库、不发事件：给定一份计划快照和一批 ops，算出新的计划、
 * 每条生效动作的权威结果（AppliedOp.result）与可撤回的反向操作。
 * 一个批次要么全部生效、要么整个抛错一条都不生效；revision 一批只加一次。
 */
import { randomUUID } from "node:crypto";
import type {
  AppliedOp,
  Source,
  Basemap,
  CanvasObject,
  Conflict,
  ExplorePlan,
  FeelCard,
  GeoJSON,
  Op,
  PlanState,
  ProfileSnapshot,
  RouteLeg,
  ShootKind,
  Stop,
  Viewport,
} from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";

export type PlanDocument = {
  destination: ExplorePlan["destination"];
  days: string[];
  kinds: ShootKind[];
  feel: FeelCard | null;
  people: ProfileSnapshot[];
  gear: ProfileSnapshot[];
  stops: Stop[];
  routes: RouteLeg[];
  conflicts: Conflict[];
  /** 画布对象与计划同源，一起进修订。 */
  canvas: CanvasObject[];
  lastViewport: Viewport | null;
  basemap: Basemap;
};

export type StoredPlan = {
  revision: number;
  state: PlanState;
  document: PlanDocument;
  updatedAt: string;
  /** 下次自动看天气的时刻（存在计划行上，页面据此显示「下次 08:00 自动看天气」）。 */
  nextCheckAt?: string | null;
};

/** 可撤回的画布动作（来自操作记录，按 seq 倒序交给引擎）。 */
export type UndoCandidate = { seq: string; actor: "page" | "agent"; inverse: Op; summary: string };

export type BatchInput = {
  plan: StoredPlan;
  ops: Op[];
  actor: "page" | "agent";
  undoCandidates?: UndoCandidate[];
  /** plan.select 要写的资料快照（由服务层按 id 解析好）。 */
  profileSnapshots?: Map<string, ProfileSnapshot>;
  now?: () => Date;
  newId?: () => string;
};

export type Batch = {
  plan: StoredPlan;
  applied: AppliedOp[];
  /** 这一批里有没有真正改变计划的业务动作（view.save 不算）。 */
  business: boolean;
  /** 被这次撤回覆盖的操作记录 seq。 */
  undone: string[];
  /** 与 applied 一一对应的反向操作；null = 不可撤回。 */
  inverses: (Op | null)[];
};

/** 撤回时按原样放回的对象（保留 id、作者与创建时间）。 */
type CanvasRestore = { op: "canvas.add"; object: CanvasObject };
type CanvasWrite =
  | Extract<Op, { op: "canvas.add" | "canvas.update" | "canvas.remove" }>
  | CanvasRestore;

export function emptyDocument(): PlanDocument {
  return {
    destination: null,
    days: [],
    kinds: [],
    feel: null,
    people: [],
    gear: [],
    stops: [],
    routes: [],
    conflicts: [],
    canvas: [],
    lastViewport: null,
    basemap: "vector",
  };
}

/** 库里读回来的正文：缺字段按空补齐，不因为一处脏数据整份读不出来。 */
export function documentOf(raw: unknown): PlanDocument {
  const base = emptyDocument();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const value = raw as Record<string, unknown>;
  const list = <T>(key: string): T[] => (Array.isArray(value[key]) ? (value[key] as T[]) : []);
  return {
    destination: (value.destination as PlanDocument["destination"]) ?? null,
    days: list<string>("days"),
    kinds: list<ShootKind>("kinds"),
    feel: (value.feel as FeelCard | null) ?? null,
    people: list<ProfileSnapshot>("people"),
    gear: list<ProfileSnapshot>("gear"),
    stops: list<Stop>("stops").map((stop) => ({ ...stop, refs: Array.isArray(stop.refs) ? stop.refs : [] })),
    routes: list<RouteLeg>("routes"),
    conflicts: list<Conflict>("conflicts"),
    canvas: list<CanvasObject>("canvas"),
    lastViewport: (value.lastViewport as Viewport | null) ?? null,
    basemap: value.basemap === "satellite" ? "satellite" : "vector",
  };
}

/** 对外读模型：计划正文 + 修订 + 状态。 */
export function planOf(dossierId: string, plan: StoredPlan): ExplorePlan {
  return {
    dossierId,
    revision: plan.revision,
    state: plan.state,
    destination: plan.document.destination,
    days: plan.document.days,
    kinds: plan.document.kinds,
    feel: plan.document.feel,
    people: plan.document.people,
    gear: plan.document.gear,
    stops: plan.document.stops,
    routes: plan.document.routes,
    conflicts: plan.document.conflicts,
    updatedAt: plan.updatedAt,
  };
}

/**
 * 停留点 detail 归一化：契约里 rules 是 {text, source?}[]、guidance/palette 是字符串数组，
 * 模型常写成单个字符串或纯字符串数组。这里统一收成契约形状，别让它在排版时才炸。
 */
export function normalizeStopDetail(input: unknown): Stop["detail"] | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const source = input as Record<string, unknown>;
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const list = (value: unknown): string[] => {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (!Array.isArray(value)) return [];
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
  };
  const rules = (value: unknown): { text: string; source?: Source }[] => {
    const items = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
    return items.flatMap((item) => {
      if (typeof item === "string") return item.trim() ? [{ text: item.trim() }] : [];
      if (item && typeof item === "object") {
        const rule = item as { text?: unknown; source?: unknown };
        const line = text(rule.text);
        if (!line) return [];
        const from = rule.source as Source | undefined;
        return [from && typeof from === "object" && typeof from.name === "string" ? { text: line, source: from } : { text: line }];
      }
      return [];
    });
  };
  const outfitInput = source.outfit && typeof source.outfit === "object" ? (source.outfit as Record<string, unknown>) : null;
  const detail: NonNullable<Stop["detail"]> = {};
  const composition = text(source.composition);
  if (composition) detail.composition = composition;
  const guidance = list(source.guidance);
  if (guidance.length) detail.guidance = guidance;
  if (outfitInput) {
    const palette = list(outfitInput.palette);
    const notes = text(outfitInput.notes);
    if (palette.length || notes) detail.outfit = { ...(palette.length ? { palette } : {}), ...(notes ? { notes } : {}) };
  }
  const normalizedRules = rules(source.rules);
  if (normalizedRules.length) detail.rules = normalizedRules;
  const fallback = text(source.fallback);
  if (fallback) detail.fallback = fallback;
  return Object.keys(detail).length ? detail : undefined;
}

/** 服务端维护、不能由 patch 改写的停留点字段。 */
const SERVER_OWNED_STOP_KEYS = new Set(["id", "state", "source", "light", "revision"]);

/** stop.update 真正允许改的字段（契约 §1 的 Stop）。写别的键会被明确拒掉。 */
const PATCHABLE_STOP_KEYS = new Set([
  "kind",
  "name",
  "geometry",
  "entry",
  "exit",
  "day",
  "window",
  "reason",
  "facing",
  "focal",
  "detail",
  "refs",
]);

/** 改了就要用户同意的停留点字段（名称 / 类型 / 地点 / 日期 / 时段）。 */
export const CONFIRMATION_SENSITIVE_STOP_KEYS = new Set([
  "name",
  "kind",
  "geometry",
  "day",
  "window",
  "entry",
  "exit",
]);

const kindLabel = (kind: Stop["kind"]): string =>
  kind === "area" ? "街区" : kind === "waypoint" ? "顺路点" : "机位";

const dayLike = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isoWithOffset = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value);

const invalid = (message: string) => new ApiFailure("INVALID_INPUT", 400, message);

/** 合法动作名：报错时一并给出来，模型不用猜也不用翻源码。 */
export const OP_NAMES = [
  "stop.add",
  "stop.update",
  "stop.remove",
  "stop.confirm",
  "plan.set",
  "plan.confirm",
  "plan.finish",
  "plan.cancel",
  "plan.select",
  "feel.set",
  "canvas.add",
  "canvas.update",
  "canvas.remove",
  "canvas.undo",
  "view.save",
] as const;

/** 结束或取消：只有还在草稿 / 待执行的计划能走这一步。 */
function assertCanEnd(current: PlanState, next: PlanState) {
  if (current === "finished" || current === "cancelled")
    throw new ApiFailure("PLAN_STATE", 409, "计划已经结束，改不回来了。");
  if (current === next) throw new ApiFailure("PLAN_STATE", 409, "计划已经是这个状态了。");
}

function assertGeometry(kind: Stop["kind"], geometry: GeoJSON.Geometry) {
  const wanted = kind === "area" ? "Polygon" : "Point";
  if (geometry?.type !== wanted)
    throw invalid(
      kind === "area" ? "街区要用区域（Polygon）表示。" : "机位和顺路点要用点位（Point）表示。",
    );
  if (wanted === "Point") {
    const coordinates = (geometry as GeoJSON.Point).coordinates ?? [];
    const [lng, lat] = coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw invalid("坐标不合法。");
  } else {
    const ring = (geometry as GeoJSON.Polygon).coordinates?.[0] ?? [];
    if (ring.length < 4) throw invalid("区域至少要 4 个点（首尾闭合）。");
  }
}

/** 跨午夜是允许的：结束可以落在次日，只要求结束晚于开始。 */
function assertWindow(window: Stop["window"]) {
  if (!window) return;
  if (!isoWithOffset(window.start) || !isoWithOffset(window.end))
    throw invalid("拍摄时段要带时区偏移的完整时间。");
  if (new Date(window.end).getTime() <= new Date(window.start).getTime())
    throw invalid("拍摄时段的结束要晚于开始。");
}

const changedKeys = (patch: object) =>
  Object.keys(patch).filter((key) => (patch as Record<string, unknown>)[key] !== undefined);

/** 反向操作要的旧值：只记 patch 里出现过的键。 */
function previousValues<T extends object>(row: T, patch: Partial<T>): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) out[key] = (row as Record<string, unknown>)[key];
  return out as Partial<T>;
}

const stopFieldLabel = (key: string): string =>
  ({
    name: "名称",
    kind: "类型",
    geometry: "位置",
    day: "日期",
    window: "时段",
    entry: "入口",
    exit: "出口",
    reason: "理由",
    facing: "朝向",
    focal: "焦段",
    detail: "细节",
    refs: "参考图",
  })[key] ?? key;

const canvasVerb = (kind: CanvasObject["kind"]): string =>
  kind === "area"
    ? "圈出"
    : kind === "marker"
      ? "标记"
      : kind === "note"
        ? "贴笔记"
        : kind === "arrow"
          ? "画箭头"
          : kind === "line"
            ? "画草图线"
            : "画自由线";

function canvasSummary(object: CanvasObject, prefix = ""): string {
  const text =
    object.kind === "note" || object.kind === "marker" ? (object.text ?? "").trim().slice(0, 24) : "";
  return `${prefix}${canvasVerb(object.kind)}${text ? `「${text}」` : ""}`;
}

/** 停留点落库前整理成服务端认可的形状：客户端的 id/state/source/light 一律不认。 */
function normalizeStop(
  draft: Omit<Stop, "id" | "state" | "source"> & { state?: "candidate" | "confirmed" },
  actor: "page" | "agent",
  newId: () => string,
): Stop {
  if (!draft || typeof draft.name !== "string" || !draft.name.trim()) throw invalid("停留点要有名字。");
  const kind: Stop["kind"] = draft.kind === "area" || draft.kind === "waypoint" ? draft.kind : "spot";
  if (!dayLike(draft.day)) throw invalid("停留点要有当地日期（YYYY-MM-DD）。");
  assertGeometry(kind, draft.geometry);
  assertWindow(draft.window ?? null);
  return {
    id: newId(),
    kind,
    name: draft.name.trim().slice(0, 120),
    state: draft.state === "confirmed" ? "confirmed" : "candidate",
    geometry: draft.geometry,
    day: draft.day,
    window: draft.window ?? null,
    refs: Array.isArray(draft.refs) ? draft.refs.filter((ref) => typeof ref === "string") : [],
    source: actor === "agent" ? "agent" : "user",
    ...(draft.entry ? { entry: draft.entry } : {}),
    ...(draft.exit ? { exit: draft.exit } : {}),
    ...(typeof draft.reason === "string" ? { reason: draft.reason.slice(0, 600) } : {}),
    ...(Number.isFinite(draft.facing) ? { facing: draft.facing } : {}),
    ...(Array.isArray(draft.focal) ? { focal: draft.focal.filter((n) => Number.isFinite(n)) } : {}),
    ...(draft.detail ? { detail: normalizeStopDetail(draft.detail) } : {}),
  };
}

/**
 * 一次批量 ops。
 *
 * 原子性：先在拷贝上逐条算，任何一条不成立就抛错，原计划不动。
 * 修订：batch 内有业务动作时 revision 恰好 +1；只有 view.save 时不变、也不记动作。
 */
export function applyBatch(input: BatchInput): Batch {
  const now = () => input.now?.() ?? new Date();
  const newId = () => input.newId?.() ?? randomUUID();
  const document: PlanDocument = structuredClone(input.plan.document);
  let state: PlanState = input.plan.state;
  const applied: AppliedOp[] = [];
  const inverses: (Op | null)[] = [];
  const undone: string[] = [];
  let business = false;
  const queue = [...(input.undoCandidates ?? [])];
  const actor: AppliedOp["actor"] = input.actor === "agent" ? "agent" : "user";

  const findStop = (id: string): Stop => {
    const found = document.stops.find((stop) => stop.id === id);
    if (!found) throw new ApiFailure("STOP_NOT_FOUND", 404, "计划里没有这个停留点，可能刚被删掉。");
    return found;
  };

  /** 画布动作（含撤回时用的反向动作）走同一段逻辑，返回权威结果与可撤回的反向操作。 */
  const writeCanvas = (op: CanvasWrite): { summary: string; result: AppliedOp["result"]; inverse: Op } => {
    if (op.op === "canvas.add") {
      // 撤回「删除」时把原对象整份放回：保留它原来的 id，后续动作还能对上。
      const draft = op.object as Partial<CanvasObject>;
      const restore = typeof draft.id === "string" && draft.id !== "";
      const object: CanvasObject = {
        id: restore ? String(draft.id) : newId(),
        kind: draft.kind as CanvasObject["kind"],
        geometry: draft.geometry as CanvasObject["geometry"],
        ...(draft.text !== undefined ? { text: draft.text } : {}),
        ...(draft.links ? { links: draft.links } : {}),
        author: restore ? (draft.author ?? actor) : actor,
        createdAt: restore ? (draft.createdAt ?? now().toISOString()) : now().toISOString(),
      };
      document.canvas.push(object);
      return {
        summary: canvasSummary(object, restore ? "放回：" : "添加："),
        result: { object },
        inverse: { op: "canvas.remove", id: object.id },
      };
    }
    if (op.op === "canvas.update") {
      const index = document.canvas.findIndex((object) => object.id === op.id);
      if (index < 0) throw new ApiFailure("CANVAS_NOT_FOUND", 404, "画布上没有这个草图，可能刚被撤掉。");
      const object = document.canvas[index];
      const patch = { ...(op.patch as Record<string, unknown>) };
      delete patch.id;
      delete patch.author;
      delete patch.createdAt;
      const keys = Object.keys(patch);
      if (!keys.length) throw invalid("没有要改的草图内容。");
      // 反向值里缺的键写 null（草图上原本没有这个字段），落 jsonb 时不会被丢掉；
      // 应用时 null 表示清空这个字段，所以「给草图加一句话」也能撤回。
      const before: Record<string, unknown> = {};
      for (const key of keys)
        before[key] = key in (object as Record<string, unknown>) ? (object as any)[key] : null;
      for (const key of keys) {
        if (patch[key] === null) delete (object as Record<string, unknown>)[key];
        else (object as Record<string, unknown>)[key] = patch[key];
      }
      return {
        summary: "修改草图",
        result: { object },
        inverse: { op: "canvas.update", id: object.id, patch: before as Partial<CanvasObject> },
      };
    }
    const index = document.canvas.findIndex((object) => object.id === op.id);
    if (index < 0) throw new ApiFailure("CANVAS_NOT_FOUND", 404, "画布上没有这个草图，可能刚被撤掉。");
    const [removed] = document.canvas.splice(index, 1);
    return {
      summary: canvasSummary(removed, "删除："),
      result: { removedObjectId: removed.id },
      inverse: { op: "canvas.add", object: { ...removed } } as CanvasRestore,
    };
  };

  for (const op of input.ops) {
    if (!op || typeof op !== "object" || typeof (op as { op?: unknown }).op !== "string")
      throw invalid("动作格式不对。");

    switch (op.op) {
      case "stop.add": {
        const stop = normalizeStop(op.stop, input.actor, newId);
        document.stops.push(stop);
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: `${stop.state === "confirmed" ? "添加并确认" : "添加候选"}${kindLabel(stop.kind)}「${stop.name}」`,
          result: { stop },
        });
        inverses.push(null);
        break;
      }
      case "stop.update": {
        const stop = findStop(op.id);
        const patch: Partial<Stop> = {};
        const rejected: string[] = [];
        for (const [key, value] of Object.entries(op.patch ?? {})) {
          if (value === undefined) continue;
          if (SERVER_OWNED_STOP_KEYS.has(key)) continue;
          if (!PATCHABLE_STOP_KEYS.has(key)) {
            rejected.push(key);
            continue;
          }
          (patch as Record<string, unknown>)[key] = value;
        }
        if (rejected.length)
          throw invalid(
            `stop.update 改不了这些字段：${rejected.join("、")}。能改的是：${[...PATCHABLE_STOP_KEYS].join("、")}（雨天备选放在 detail.fallback）。`,
          );
        const keys = changedKeys(patch);
        if (!keys.length) throw invalid("没有要改的停留点内容。");
        if (patch.detail !== undefined)
          patch.detail = normalizeStopDetail(patch.detail) ?? undefined;
        if (patch.geometry) assertGeometry(patch.kind ?? stop.kind, patch.geometry);
        if ("window" in patch) assertWindow(patch.window ?? null);
        if (patch.day !== undefined && !dayLike(patch.day)) throw invalid("日期要写成 YYYY-MM-DD。");
        if (patch.name !== undefined && (typeof patch.name !== "string" || !patch.name.trim()))
          throw invalid("名字不能为空。");
        const before = previousValues(stop, patch);
        Object.assign(stop, patch);
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: `修改${kindLabel(stop.kind)}「${stop.name}」的${keys.map(stopFieldLabel).join("、")}`,
          result: { stop },
        });
        inverses.push({ op: "stop.update", id: stop.id, patch: before });
        break;
      }
      case "stop.remove": {
        const stop = findStop(op.id);
        const index = document.stops.findIndex((row) => row.id === stop.id);
        document.stops.splice(index, 1);
        document.routes = document.routes.filter((leg) => leg.from !== stop.id && leg.to !== stop.id);
        document.conflicts = document.conflicts.filter((row) => row.stopId !== stop.id);
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: `删除${stop.state === "confirmed" ? "" : "候选"}${kindLabel(stop.kind)}「${stop.name}」`,
          result: { removedStopId: stop.id },
        });
        inverses.push(null);
        break;
      }
      case "stop.confirm": {
        const ids = Array.isArray(op.ids) ? op.ids.filter((id) => typeof id === "string") : [];
        if (!ids.length) throw invalid("要确认哪些停留点？");
        const updated = ids.map((id) => {
          const stop = findStop(id);
          stop.state = "confirmed";
          return stop;
        });
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary:
            updated.length === 1
              ? `确认${kindLabel(updated[0].kind)}「${updated[0].name}」`
              : `确认 ${updated.length} 个停留点`,
          result: { stops: updated },
        });
        inverses.push(null);
        break;
      }
      case "plan.set": {
        const patch = op.patch ?? {};
        const next: Partial<Pick<ExplorePlan, "destination" | "days" | "kinds">> = {};
        if (patch.destination !== undefined) {
          const destination = patch.destination;
          if (destination !== null) {
            if (typeof destination === "string")
              throw invalid(
                "plan.set 的 destination 要写成 {name, center:[经度,纬度], timezone}，不能只给地名。",
              );
            if (!destination?.name?.trim()) throw invalid("地点要有名字。");
            if (!Array.isArray(destination.center) || destination.center.length !== 2)
              throw invalid("地点要有中心坐标。");
            if (typeof destination.timezone !== "string" || !destination.timezone.includes("/"))
              throw invalid("地点要有 IANA 时区。");
          }
          next.destination = destination;
        }
        if (patch.days !== undefined) {
          if (!Array.isArray(patch.days) || patch.days.some((day) => !dayLike(day)))
            throw invalid("行程日期要写成 YYYY-MM-DD。");
          next.days = [...patch.days].sort();
        }
        if (patch.kinds !== undefined) {
          const allowed = new Set(["portrait", "landscape", "travel", "street"]);
          if (!Array.isArray(patch.kinds) || patch.kinds.some((kind) => !allowed.has(kind)))
            throw invalid("拍法只能是 portrait / landscape / travel / street。");
          next.kinds = [...patch.kinds];
        }
        const keys = Object.keys(next);
        if (!keys.length) throw invalid("没有要改的计划内容。");
        const before: Partial<ExplorePlan> = {};
        for (const key of keys)
          (before as Record<string, unknown>)[key] = (document as Record<string, unknown>)[key];
        Object.assign(document, next);
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: `更新计划的${keys
            .map((key) => ({ destination: "地点", days: "日期", kinds: "拍法" })[key] ?? key)
            .join("、")}`,
          result: { plan: next },
        });
        inverses.push({ op: "plan.set", patch: before } as Op);
        break;
      }
      case "plan.confirm": {
        if (state !== "draft")
          throw new ApiFailure("PLAN_STATE", 409, "这份计划已经确认过，改完内容仍然在待执行。");
        if (!document.stops.length)
          throw new ApiFailure("PLAN_EMPTY", 409, "计划里还没有停留点，先把要去的点放上去。");
        // 先数候选（下一行就全转正了，晚数永远是 0）。
        const candidatesBefore = document.stops.filter((stop) => stop.state === "candidate").length;
        for (const stop of document.stops) stop.state = "confirmed";
        state = "ready";
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: (() => {
            const candidates = candidatesBefore;
            return `确认整份计划，进入待执行（共 ${document.stops.length} 个停留点${
              candidates ? `，其中 ${candidates} 个候选一并转正` : ""
            }）`;
          })(),
          result: { plan: { state: "ready" }, stops: document.stops },
        });
        inverses.push(null);
        break;
      }
      case "plan.finish":
      case "plan.cancel": {
        const next: PlanState = op.op === "plan.finish" ? "finished" : "cancelled";
        assertCanEnd(state, next);
        state = next;
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: next === "finished" ? "结束计划" : "取消计划",
          result: { plan: { state: next } },
        });
        inverses.push(null);
        break;
      }
      case "plan.select": {
        const resolve = (ids: string[]): ProfileSnapshot[] =>
          ids.map((id) => {
            const snapshot = input.profileSnapshots?.get(id);
            if (!snapshot)
              throw new ApiFailure("PROFILE_NOT_FOUND", 404, "计划里有资料选不上，先确认这条资料还在。");
            return snapshot;
          });
        const next: Partial<Pick<ExplorePlan, "people" | "gear">> = {};
        if (Array.isArray(op.people)) next.people = resolve(op.people);
        if (Array.isArray(op.gear)) next.gear = resolve(op.gear);
        if (!Object.keys(next).length) throw invalid("没有要选的资料。");
        Object.assign(document, next);
        business = true;
        const names = [...(next.people ?? []), ...(next.gear ?? [])].map(
          (snapshot) => (snapshot.data as { name?: string }).name ?? "资料",
        );
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary:
            names.length === 1 ? `选择「${names[0]}」` : `选择 ${names.length} 项资料`,
          result: { plan: next },
        });
        inverses.push(null);
        break;
      }
      case "feel.set": {
        const feel = op.feel;
        if (typeof feel === "string")
          throw invalid(
            "feel.set 的 feel 要写成 {refIds:[], observations:[{aspect, text}], guesses:[{aspect, text}]}，不能只给一句话。",
          );
        if (!feel || !Array.isArray(feel.observations)) throw invalid("想要的感觉要有观察内容。");
        document.feel = feel;
        business = true;
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: "记录想要的感觉",
          result: { plan: { feel } },
        });
        inverses.push(null);
        break;
      }
      case "canvas.add":
      case "canvas.update":
      case "canvas.remove": {
        const written = writeCanvas(op);
        business = true;
        applied.push({ ...op, opId: newId(), actor, summary: written.summary, result: written.result });
        inverses.push(written.inverse);
        break;
      }
      case "canvas.undo": {
        // 用户能撤回最近的画布改动（含助手的）；助手只能撤回自己的。
        const index = queue.findIndex((candidate) => input.actor !== "agent" || candidate.actor === "agent");
        if (index < 0)
          throw new ApiFailure(
            "NOTHING_TO_UNDO",
            409,
            input.actor === "agent" ? "助手没有可撤回的画布改动。" : "没有可撤回的画布改动。",
          );
        const [candidate] = queue.splice(index, 1);
        const written = writeCanvas(candidate.inverse as CanvasWrite);
        business = true;
        undone.push(candidate.seq);
        applied.push({
          ...op,
          opId: newId(),
          actor,
          summary: `撤回：${candidate.summary}`,
          result: written.result,
        });
        // 撤回本身不再可撤回，免得来回翻。
        inverses.push(null);
        break;
      }
      case "view.save": {
        if (!op.viewport || !Array.isArray(op.viewport.center))
          throw invalid("视野要有中心坐标。");
        document.lastViewport = op.viewport;
        document.basemap = op.basemap === "satellite" ? "satellite" : "vector";
        // 只记最后视野：不进 revision、不记动作、不推事件。
        break;
      }
      default:
        throw invalid(
          `没有这个动作（${String((op as { op?: unknown }).op ?? "")}）。可用动作：${OP_NAMES.join("、")}。`,
        );
    }
  }

  return {
    plan: {
      revision: business ? input.plan.revision + 1 : input.plan.revision,
      state,
      document,
      updatedAt: business ? now().toISOString() : input.plan.updatedAt,
    },
    applied,
    business,
    undone,
    inverses,
  };
}

/**
 * Agent 主动做这些动作要先得到用户同意（PRD 7、契约第 3 节）：
 * 候选转正式、改已确认停留点的名称/地点/日期/时段、删已确认停留点、改计划状态。
 * 页面点击本身就是授权，不走这里。
 */
export function needsAcceptance(plan: StoredPlan, op: Op): boolean {
  const byId = (id: string) => plan.document.stops.find((stop) => stop.id === id);
  switch (op.op) {
    case "stop.confirm":
      return op.ids.some((id) => byId(id)?.state === "candidate");
    case "stop.add":
      return op.stop?.state === "confirmed";
    case "stop.update": {
      const stop = byId(op.id);
      if (!stop || stop.state !== "confirmed") return false;
      return Object.keys(op.patch ?? {}).some(
        (key) => CONFIRMATION_SENSITIVE_STOP_KEYS.has(key) && (op.patch as Record<string, unknown>)[key] !== undefined,
      );
    }
    case "stop.remove":
      return byId(op.id)?.state === "confirmed";
    case "plan.set":
      // 已经在待执行的计划，换地点或改日期要用户点头。
      return plan.state === "ready" && (op.patch?.destination !== undefined || op.patch?.days !== undefined);
    case "plan.confirm":
    case "plan.finish":
    case "plan.cancel":
      return true;
    default:
      return false;
  }
}

/** 计划修改卡上给人看的前后对照。 */
export function describeChanges(
  plan: StoredPlan,
  ops: Op[],
): { stopId: string; before: Partial<Stop> | null; after: Partial<Stop> | null }[] {
  const changes: { stopId: string; before: Partial<Stop> | null; after: Partial<Stop> | null }[] = [];
  for (const op of ops) {
    if (op.op === "stop.confirm") {
      for (const id of op.ids) {
        const stop = plan.document.stops.find((row) => row.id === id);
        if (stop && stop.state === "candidate")
          changes.push({
            stopId: id,
            before: { state: "candidate", name: stop.name, kind: stop.kind },
            after: { state: "confirmed", name: stop.name, kind: stop.kind },
          });
      }
    } else if (op.op === "stop.add" && op.stop?.state === "confirmed") {
      changes.push({
        stopId: "",
        before: null,
        after: { state: "confirmed", name: op.stop.name, kind: op.stop.kind },
      });
    } else if (op.op === "stop.update") {
      const stop = plan.document.stops.find((row) => row.id === op.id);
      const patch: Partial<Stop> = {};
      for (const [key, value] of Object.entries(op.patch ?? {}))
        if (!SERVER_OWNED_STOP_KEYS.has(key) && value !== undefined)
          (patch as Record<string, unknown>)[key] = value;
      changes.push({ stopId: op.id, before: stop ? previousValues(stop, patch) : null, after: patch });
    } else if (op.op === "stop.remove") {
      const stop = plan.document.stops.find((row) => row.id === op.id);
      changes.push({
        stopId: op.id,
        before: stop ? { name: stop.name, kind: stop.kind, state: stop.state, day: stop.day, window: stop.window } : null,
        after: null,
      });
    }
  }
  return changes;
}

/** 计划修改卡的一句话标题。 */
export function describeBatch(plan: StoredPlan, ops: Op[]): string {
  const parts: string[] = [];
  const byId = (id: string) => plan.document.stops.find((stop) => stop.id === id);
  // 整份确认会把所有候选一起转正：卡上要照实写，别只说「确认 N 个停留点」。
  const wholePlan = ops.some((op) => op.op === "plan.confirm");
  const candidates = plan.document.stops.filter((stop) => stop.state === "candidate").length;
  for (const op of ops) {
    if (op.op === "plan.confirm")
      parts.push(
        candidates
          ? `确认整份计划，进入待执行（${candidates} 个候选一并转为已确认）`
          : "确认整份计划，进入待执行",
      );
    else if (op.op === "plan.finish") parts.push("结束这份计划");
    else if (op.op === "plan.cancel") parts.push("取消这份计划");
    else if (op.op === "plan.set") parts.push("改计划的" + (op.patch?.days ? "日期" : op.patch?.destination ? "地点" : "内容"));
    else if (op.op === "stop.confirm")
      // 已经写了「整份确认会把候选一起转正」，这套逐点确认就不再重复念一遍。
      parts.push(
        wholePlan
          ? ""
          : op.ids.length === 1 && byId(op.ids[0])
            ? `把「${byId(op.ids[0])!.name}」定下来`
            : `确认 ${op.ids.length} 个停留点`,
      );
    else if (op.op === "stop.add" && op.stop?.state === "confirmed") parts.push(`加上并确认「${op.stop.name}」`);
    else if (op.op === "stop.update" && byId(op.id)) parts.push(`改「${byId(op.id)!.name}」`);
    else if (op.op === "stop.remove" && byId(op.id)) parts.push(`删掉「${byId(op.id)!.name}」`);
  }
  return parts.filter(Boolean).join("；").slice(0, 300) || "按刚才说的改一下计划";
}
