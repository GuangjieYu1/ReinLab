/**
 * 探索台计划服务（design/prd/07-explore-contract.md 第 2～4 节）。
 *
 * 页面接口和 Agent 工具调同一组函数：一批 ops 在一个事务里原子生效，
 * 修订号批次内只 +1；Agent 要改已确认内容时先出一张计划修改卡，用户点了才生效。
 */
import { createHash } from "node:crypto";
import type pg from "pg";
import type {
  AppliedOp,
  CanvasObject,
  ExplorePlan,
  LngLat,
  Op,
  PendingChange,
  ProfileSnapshot,
  RefImage,
  Source,
  WeatherHour,
} from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { canonical } from "../api/context";
import { consumeApproval, effectKeyOf, requestApproval } from "../run/approval";
import {
  applyBatch,
  describeBatch,
  describeChanges,
  documentOf,
  needsAcceptance,
  planOf,
  type StoredPlan,
  type UndoCandidate,
} from "./plan";
import { consumeUserAuthorization, verifyUserAuthorization } from "./authorize";
import { nextCheckAt } from "./schedule";
import { conflictsOf, walkLegs } from "./providers";
import { profileSnapshots as snapshotsFor } from "./profiles";
import { listRefs } from "./refs";
import {
  fetchStopWeather,
  weatherSource,
  type StopWeatherResult,
  type WeatherTransport,
} from "./weather";

type Client = pg.PoolClient;

export const CAPABILITY = "explore.ops";

export type PlanBundle = {
  plan: ExplorePlan;
  canvas: CanvasObject[];
  refs: RefImage[];
  lastViewport: StoredPlan["document"]["lastViewport"];
  basemap: StoredPlan["document"]["basemap"];
};

export type OpsRequest = {
  /** 页面必带；Agent 省略时用最新修订。 */
  baseRevision?: number;
  ops: Op[];
  actor: "page" | "agent";
  run?: string | null;
  authorization?: { messageId?: string };
  /** 用户刚在审批卡上点过「同意」：这就是授权本身。 */
  approved?: { approvalId: string };
};

export type OpsOutcome = {
  revision: number;
  applied: AppliedOp[];
  pending: PendingChange | null;
  plan: ExplorePlan;
  bench: string;
  dossierId: string;
};

/** 读一份计划（必要时新建默认草稿）；lock=true 时锁住行，供写批次串行化。 */
export async function loadPlan(
  client: Client,
  account: string,
  dossier: string,
  options: { lock?: boolean } = {},
): Promise<{ plan: StoredPlan; bench: string }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dossier))
    throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  const dossierRow = (
    await client.query("select id,bench from dossier where account_id=$1 and id=$2", [account, dossier])
  ).rows[0];
  if (!dossierRow) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (dossierRow.bench !== "exploration")
    throw new ApiFailure("BENCH_UNSUPPORTED", 400, "只有探索台档案有旅拍计划。");
  await client.query(
    "insert into explore_plan(account_id,dossier_id) values($1,$2) on conflict (account_id,dossier_id) do nothing",
    [account, dossier],
  );
  const row = (
    await client.query(
      `select revision,state,document,updated_at from explore_plan
        where account_id=$1 and dossier_id=$2 ${options.lock ? "for update" : ""}`,
      [account, dossier],
    )
  ).rows[0];
  return {
    plan: {
      revision: Number(row.revision),
      state: row.state,
      document: documentOf(row.document),
      updatedAt: new Date(row.updated_at).toISOString(),
    },
    bench: dossierRow.bench,
  };
}

export async function readPlan(client: Client, account: string, dossier: string): Promise<PlanBundle> {
  const { plan } = await loadPlan(client, account, dossier);
  return {
    plan: planOf(dossier, plan),
    canvas: plan.document.canvas,
    refs: await listRefs(client, account, dossier),
    lastViewport: plan.document.lastViewport,
    basemap: plan.document.basemap,
  };
}

const opsHash = (ops: Op[]) => createHash("sha256").update(canonical({ ops })).digest("hex");

/** 可撤回的画布动作：最近的在前面。 */
async function undoCandidates(client: Client, account: string, dossier: string): Promise<UndoCandidate[]> {
  const rows = (
    await client.query(
      `select seq::text seq, actor, summary, inverse from explore_op
        where account_id=$1 and dossier_id=$2 and inverse is not null and undone_by is null
          and op in ('canvas.add','canvas.update','canvas.remove')
        order by seq desc limit 50`,
      [account, dossier],
    )
  ).rows;
  return rows.map((row) => ({
    seq: row.seq,
    actor: row.actor === "agent" ? "agent" : "page",
    inverse: row.inverse as Op,
    summary: String(row.summary ?? "画布改动"),
  }));
}

/**
 * 一个批次的 ops。
 *
 * Agent 的受保护动作先核对授权：用户这句话明确要求了就执行；否则出计划修改卡，
 * 整批不执行、修订不变、不推 explore.op。
 */
export async function applyOps(
  client: Client,
  account: string,
  dossier: string,
  request: OpsRequest,
): Promise<OpsOutcome> {
  const { plan, bench } = await loadPlan(client, account, dossier, { lock: true });
  const ops = request.ops as Op[];

  // 负数 = 页面表示「不关心修订」（只存视野时）；其余按乐观并发校验。
  const declaredRevision =
    request.baseRevision !== undefined && request.baseRevision >= 0 ? request.baseRevision : undefined;
  if (declaredRevision !== undefined && declaredRevision !== plan.revision)
    throw new ApiFailure(
      "REVISION_CONFLICT",
      409,
      "计划刚被改过，请按最新状态再来一次。",
      { revision: plan.revision, current: planOf(dossier, plan) },
    );

  if (request.actor === "agent" && !request.approved) {
    const guarded = ops.filter((op) => needsAcceptance(plan, op));
    if (guarded.length) {
      const verdict = await verifyUserAuthorization(client, {
        account,
        dossier,
        run: request.run ?? null,
        messageId: request.authorization?.messageId,
        ops: guarded,
        plan,
      });
      if (verdict.ok) {
        // 一句话只用一次：用掉就记账，之后再拿同一句当授权会被拦下。
        await consumeUserAuthorization(client, { account, dossier, messageId: verdict.messageId });
        return commitBatch(client, account, dossier, bench, request, plan);
      }
      return pendingCard(client, account, dossier, bench, request, plan, guarded);
    }
  }

  if (request.approved) {
    // 审批卡批准的是当时那个修订：计划已经变了就不套用，免得覆盖用户后来的修改。
    const card = (
      await client.query(
        "select effects,consumed_at,state,effect_key from approval where id=$1 and account_id=$2",
        [request.approved.approvalId, account],
      )
    ).rows[0];
    if (!card) throw new ApiFailure("APPROVAL_NOT_FOUND", 404, "这张审批卡不存在了。");
    // kernel 卡的 effects 是数组（[{kind, forRevision, ops…}]）。
    const effectsOf = Array.isArray(card.effects) ? card.effects[0] : card.effects;
    // 契约：批准后在当前最新修订上执行；只有目标本身变了才作废。
    // 改一个停留点的时段，不该因为别处加了一个点就整张卡失效。
    assertApprovedStillApplies(plan, effectsOf, ops);
    // 有 effect_key 的卡（Agent 计划修改卡）按一次性键消费；
    // 天气建议卡没有键，靠「pending → approved」的状态转换保证只应用一次。
    if (card.effect_key) {
      const consumed = await consumeApproval(client, {
        approvalId: request.approved.approvalId,
        effectKey: effectKeyOf(CAPABILITY, opsHash(ops)),
      });
      if (!consumed)
        throw new ApiFailure("APPROVAL_NOT_CONSUMABLE", 409, "这张卡已经用过了，重新发起一次。");
    }
  }

  return commitBatch(client, account, dossier, bench, request, plan);
}

async function pendingCard(
  client: Client,
  account: string,
  dossier: string,
  bench: string,
  request: OpsRequest,
  plan: StoredPlan,
  guarded: Op[],
): Promise<OpsOutcome> {
  if (!request.run) throw new ApiFailure("RUN_REQUIRED", 400, "助手的动作要挂在一次对话上。");
  const summary = describeBatch(plan, guarded);
  const changes = describeChanges(plan, guarded);
  const card = await requestApproval(client, {
    account,
    dossier,
    run: request.run,
    capability: CAPABILITY,
    argsHash: opsHash(request.ops as Op[]),
    title: summary,
    effects: [
      {
        kind: "explore.planChange",
        dossierId: dossier,
        forRevision: plan.revision,
        ops: request.ops,
        summary,
        changes,
      },
    ],
    risk: "write",
  });
  return {
    revision: plan.revision,
    applied: [],
    pending: {
      approvalId: card.id,
      ops: request.ops as Op[],
      summary,
      changes,
      forRevision: plan.revision,
    },
    plan: planOf(dossier, plan),
    bench,
    dossierId: dossier,
  };
}

async function commitBatch(
  client: Client,
  account: string,
  dossier: string,
  bench: string,
  request: OpsRequest,
  plan: StoredPlan,
): Promise<OpsOutcome> {
  // 第一次确认整份计划：账户时区没设就请用户先给一个（确认卡里默认浏览器时区）。
  const confirmOp = (request.ops as (Op & { timezone?: string })[]).find((op) => op.op === "plan.confirm");
  if (confirmOp) await requireTimezone(client, account, confirmOp.timezone);
  const needsUndo = (request.ops as Op[]).some((op) => op.op === "canvas.undo");
  // 选资料要把快照落到计划里：刷新时采用最新修订，否则沿用当时那一版。
  const selects = (request.ops as Op[]).filter((op) => op.op === "plan.select");
  const resolvedProfiles = new Map<string, ProfileSnapshot>();
  for (const select of selects) {
    const refresh = (select as { refresh?: boolean }).refresh === true;
    const people = (select as { people?: string[] }).people;
    const gear = (select as { gear?: string[] }).gear;
    if (Array.isArray(people))
      for (const snapshot of await snapshotsFor(client, account, people, "model", {
        refresh,
        existing: plan.document.people,
      }))
        resolvedProfiles.set(snapshot.profileId, snapshot);
    if (Array.isArray(gear))
      for (const snapshot of await snapshotsFor(client, account, gear, "gear", {
        refresh,
        existing: plan.document.gear,
      }))
        resolvedProfiles.set(snapshot.profileId, snapshot);
  }
  const batch = applyBatch({
    plan,
    ops: request.ops as Op[],
    actor: request.actor,
    undoCandidates: needsUndo ? await undoCandidates(client, account, dossier) : [],
    profileSnapshots: resolvedProfiles,
  });

  // 停留点或地点变了：在同一批次里重算步行路线与冲突（契约第 3 节）。
  const touched = (request.ops as Op[]).some(
    (op) => op.op.startsWith("stop.") || op.op === "plan.confirm" || op.op === "plan.set",
  );
  if (batch.business && touched) {
    const confirmed = batch.plan.document.stops.filter((stop) => stop.state === "confirmed");
    const timezone = batch.plan.document.destination?.timezone ?? null;
    const legs = await walkLegs(confirmed, { timezone });
    batch.plan.document.routes = legs;
    batch.plan.document.conflicts = conflictsOf(confirmed, legs);
    const last = batch.applied[batch.applied.length - 1];
    if (last)
      last.result = { ...last.result, routes: legs, conflicts: batch.plan.document.conflicts };
  }

  if (batch.business) {
    // 待执行才监测天气：确认整份计划时排下一次检查（账户时区 08/16/23），
    // 结束/取消就把日程撤掉。
    const accountZone = batch.plan.state === "ready" ? await accountTimezone(client, account) : null;
    const scheduled = accountZone ? nextCheckAt(accountZone, new Date()) : null;
    await client.query(
      `update explore_plan set revision=$3, state=$4, document=$5::jsonb, updated_at=now(),
              next_check_at=$6
        where account_id=$1 and dossier_id=$2`,
      [
        account,
        dossier,
        batch.plan.revision,
        batch.plan.state,
        JSON.stringify(batch.plan.document),
        scheduled,
      ],
    );
    const seqs: string[] = [];
    for (const [index, applied] of batch.applied.entries()) {
      const inserted = (
        await client.query(
          `insert into explore_op(account_id,dossier_id,revision,actor,op,summary,detail,inverse)
           values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) returning seq::text seq`,
          [
            account,
            dossier,
            batch.plan.revision,
            request.actor,
            applied.op,
            applied.summary,
            JSON.stringify(applied),
            batch.inverses[index] ? JSON.stringify(batch.inverses[index]) : null,
          ],
        )
      ).rows[0];
      seqs.push(inserted.seq);
    }
    if (batch.undone.length && seqs.length) {
      // 记在「撤回」那一条上：批次里撤回后面还可能跟着别的动作。
      const undoIndex = batch.applied.findIndex((entry) => entry.op === "canvas.undo");
      const markedBy = seqs[undoIndex >= 0 ? undoIndex : seqs.length - 1];
      await client.query(
        `update explore_op set undone_by=$3
          where account_id=$1 and dossier_id=$2 and seq = any($4::bigint[])`,
        [account, dossier, markedBy, batch.undone],
      );
    }
    await client.query(
      "update dossier set last_activity_at=now() where account_id=$1 and id=$2 and lifecycle='active'",
      [account, dossier],
    );
  } else if (batch.plan.document.lastViewport) {
    await client.query(
      `update explore_plan set document=$3::jsonb where account_id=$1 and dossier_id=$2`,
      [account, dossier, JSON.stringify(batch.plan.document)],
    );
  }

  return {
    revision: batch.plan.revision,
    applied: batch.applied,
    pending: null,
    plan: planOf(dossier, batch.plan),
    bench,
    dossierId: dossier,
  };
}

/** 账户时区（天气检查按它每天 08/16/23 跑）。 */
export async function accountTimezone(client: Client, account: string): Promise<string | null> {
  const row = (await client.query("select timezone from account where id=$1", [account])).rows[0];
  return (row?.timezone as string | null) ?? null;
}

export async function saveTimezone(client: Client, account: string, timezone: string) {
  await client.query("update account set timezone=$2 where id=$1", [account, timezone]);
}

/** 计划确认前要有时区：没有就请用户在确认卡里给一个（默认浏览器时区）。 */
export async function requireTimezone(client: Client, account: string, provided?: string) {
  if (provided) {
    await saveTimezone(client, account, provided);
    return provided;
  }
  const existing = await accountTimezone(client, account);
  if (existing) return existing;
  throw new ApiFailure("TIMEZONE_REQUIRED", 409, "天气检查要用账户时区，先确认一个时区（默认取浏览器时区）。");
}

/**
 * 这张审批卡现在还适用吗？
 * 改停留点：点还在，且卡上那几项仍是当时的值（用户后来自己改过就别套用）。
 * 删停留点：点还在。整份计划类动作：修订没变。
 */
function assertApprovedStillApplies(plan: StoredPlan, effects: any, ops: Op[]) {
  const stale = () =>
    new ApiFailure("PLAN_STALE", 409, "计划在这张卡之后改过了，这次修改不再适用。");
  const forRevision = Number(effects?.forRevision ?? 0);
  const changes = Array.isArray(effects?.changes) ? effects.changes : [];
  for (const op of ops) {
    if (op.op === "stop.update") {
      const stop = plan.document.stops.find((row) => row.id === op.id);
      if (!stop) throw stale();
      const change = changes.find((row: any) => row?.stopId === op.id);
      for (const [key, value] of Object.entries(change?.before ?? {})) {
        if (["id", "state", "source", "light", "revision"].includes(key)) continue;
        const current = (stop as Record<string, unknown>)[key] ?? null;
        if (canonical({ v: current }) !== canonical({ v: (value as unknown) ?? null })) throw stale();
      }
    } else if (op.op === "stop.remove") {
      if (!plan.document.stops.some((row) => row.id === op.id)) throw stale();
    } else if (
      op.op === "plan.confirm" ||
      op.op === "plan.finish" ||
      op.op === "plan.cancel" ||
      op.op === "plan.set"
    ) {
      if (forRevision !== plan.revision) throw stale();
    }
  }
}

// ── 天气（06 §5.2、07 契约第 2 节） ─────────────────────────────

/** 同一份快照的复用时长：短时间反复看不用重复取数。 */
const WEATHER_TTL_MS = 20 * 60_000;

export type WeatherBundle = {
  state: "ok" | "out_of_range" | "failed";
  /** 每个停留点带自己的状态：某一天还没进预报范围时，其他点照常给数。 */
  byStop: {
    stopId: string;
    at: [number, number];
    hours: WeatherHour[];
    state: "ok" | "out_of_range" | "failed";
    fromDate?: string;
  }[];
  destination: { at: [number, number]; hours: WeatherHour[] } | null;
  fetchedAt: string | null;
  source: Source;
  /** 还没进入预报范围时，大约从哪天起可查（当地日期）。 */
  fromDate?: string;
  /** 还没有后台调度，如实给 null（第 3 批做 08/16/23 检查）。 */
  nextCheckAt: string | null;
  /** 取数失败或超范围时给人看的一句话。 */
  reason?: string;
};

type WeatherTarget = {
  key: string;
  at: [number, number];
  day: string;
  window: { start: string; end: string } | null;
};

/** 一个停留点这段时间的签名：日期或时段变了，旧快照就不再适用。 */
const weatherSignature = (target: WeatherTarget) =>
  [target.day, target.window?.start ?? "", target.window?.end ?? ""].join("|");

async function cachedWeather(
  client: Client,
  account: string,
  dossier: string,
  target: WeatherTarget,
  options: { refresh?: boolean; transport?: WeatherTransport; now: Date; timezone: string },
): Promise<{ result: StopWeatherResult; fresh: boolean }> {
  const signature = weatherSignature(target);
  const row = (
    await client.query(
      `select signature,state,hours,from_date,source,reason,fetched_at
         from explore_weather where account_id=$1 and dossier_id=$2 and key=$3`,
      [account, dossier, target.key],
    )
  ).rows[0];
  const freshEnough =
    row &&
    row.signature === signature &&
    row.fetched_at &&
    options.now.getTime() - new Date(row.fetched_at).getTime() < WEATHER_TTL_MS;
  if (freshEnough && !options.refresh)
    return {
      fresh: true,
      result: {
        state: row.state,
        hours: row.hours ?? [],
        ...(row.from_date ? { fromDate: row.from_date } : {}),
        fetchedAt: new Date(row.fetched_at).toISOString(),
        source: row.source ?? weatherSource(),
        ...(row.reason ? { reason: row.reason } : {}),
      },
    };

  const result = await fetchStopWeather({
    at: target.at,
    timezone: options.timezone,
    window: target.window,
    day: target.day,
    transport: options.transport,
    now: options.now,
  });
  await client.query(
    `insert into explore_weather(account_id,dossier_id,key,at,signature,state,hours,from_date,source,reason,fetched_at,updated_at)
     values($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,now())
     on conflict (account_id,dossier_id,key) do update set
       at=excluded.at, signature=excluded.signature, state=excluded.state, hours=excluded.hours,
       from_date=excluded.from_date, source=excluded.source, reason=excluded.reason,
       fetched_at=excluded.fetched_at, updated_at=now()`,
    [
      account,
      dossier,
      target.key,
      JSON.stringify(target.at),
      signature,
      result.state,
      JSON.stringify(result.hours),
      result.fromDate ?? null,
      JSON.stringify(result.source),
      result.reason ?? null,
      result.fetchedAt,
    ],
  );
  return { result, fresh: false };
}

const WORST: Record<WeatherBundle["state"], number> = { ok: 0, out_of_range: 1, failed: 2 };

/**
 * 一份计划的天气视图：默认看全部已确认停留点，也可以只看一个。
 * 每个停留点按自己的位置和当地日期/时段取数；还没有停留点时按目的地给。
 */
export async function weatherView(
  client: Client,
  account: string,
  dossier: string,
  options: { stopId?: string; refresh?: boolean; transport?: WeatherTransport } = {},
): Promise<WeatherBundle> {
  const { plan } = await loadPlan(client, account, dossier);
  const destination = plan.document.destination;
  if (!destination)
    throw new ApiFailure("DESTINATION_REQUIRED", 409, "先确定拍摄地点和时区，天气要按当地时间给。");
  const stops = plan.document.stops;
  const chosen = options.stopId
    ? stops.filter((stop) => stop.id === options.stopId)
    : stops.filter((stop) => stop.state === "confirmed");
  if (options.stopId && !chosen.length)
    throw new ApiFailure("STOP_NOT_FOUND", 404, "计划里没有这个停留点。");

  const targets: WeatherTarget[] = chosen.length
    ? chosen.map((stop) => ({
        key: stop.id,
        at: stopCenter(stop.geometry),
        day: stop.day,
        window: stop.window ?? null,
      }))
    : [
        {
          key: "destination",
          at: destination.center,
          day: plan.document.days[0] ?? new Date().toISOString().slice(0, 10),
          window: null,
        },
      ];

  const now = new Date();
  const results = await Promise.all(
    targets.map((target) =>
      cachedWeather(client, account, dossier, target, {
        refresh: options.refresh,
        transport: options.transport,
        now,
        timezone: destination.timezone,
      }),
    ),
  );

  let state: WeatherBundle["state"] = "ok";
  let fetchedAt: string | null = null;
  let fromDate: string | undefined;
  let reason: string | undefined;
  let source: Source = weatherSource();
  const byStop: WeatherBundle["byStop"] = [];
  const destinationHours: { at: [number, number]; hours: WeatherHour[] }[] = [];
  for (const [index, { result }] of results.entries()) {
    const target = targets[index];
    if (target.key === "destination") {
      if (result.state === "ok") destinationHours.push({ at: target.at, hours: result.hours });
    } else
      byStop.push({
        stopId: target.key,
        at: target.at,
        hours: result.hours,
        state: result.state,
        ...(result.fromDate ? { fromDate: result.fromDate } : {}),
      });
    if (!fromDate && result.fromDate) fromDate = result.fromDate;
    if (!reason && result.reason) reason = result.reason;
    if (result.fetchedAt && (!fetchedAt || result.fetchedAt > fetchedAt)) fetchedAt = result.fetchedAt;
    if (result.state === "ok") source = result.source;
  }
  // 顶层状态说「这次整体能不能用」：拿到数据就是 ok（个别点超范围在各点自己的 state 里）；
  // 一个数都没拿到时，才整体标 out_of_range / failed。
  const gotData = results.some(({ result }) => result.state === "ok" && result.hours.length > 0);
  if (!gotData) {
    const worst = results.reduce(
      (acc, { result }) => (WORST[result.state] > WORST[acc] ? result.state : acc),
      "ok" as WeatherBundle["state"],
    );
    state = worst === "ok" ? "failed" : worst;
    if (state === "failed" && !reason) reason = "这次没拿到任何停留点的天气。";
  }

  return {
    state,
    byStop,
    destination: destinationHours[0] ?? null,
    fetchedAt,
    source,
    ...(fromDate ? { fromDate } : {}),
    nextCheckAt: null,
    ...(reason ? { reason } : {}),
  };
}

/** 停留点的代表位置：点用它自己，区域用重心（写清是区域中心，不当已确认站位）。 */
export function stopCenter(geometry: { type: string; coordinates: unknown }): [number, number] {
  if (geometry.type === "Point") return geometry.coordinates as [number, number];
  return polygonCenter(geometry);
}

function polygonCenter(geometry: { coordinates: unknown }): [number, number] {
  const ring = (geometry.coordinates as number[][][])?.[0] ?? [];
  if (!ring.length) return [0, 0];
  // 简单重心：区域通常很小，够用来取预报网格。
  const sum = ring.reduce<[number, number]>((acc, point) => [acc[0] + point[0], acc[1] + point[1]], [0, 0]);
  return [sum[0] / ring.length, sum[1] / ring.length];
}
