import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  Claim,
  ClaimStatus,
  Evidence,
  SwarmReport,
  SwarmRoute,
} from "@reinlab/contracts";

/** 结论依据（契约里是 Claim["basis"]）。 */
type Basis = Claim["basis"];
/** 路线就是契约里的 SwarmRoute（插件登记的那份）。 */
type SwarmApproach = SwarmRoute;
import { ApiFailure } from "../api/errors";

/**
 * 群研黑板（design/prd/12-swarm.md §4、§5；14-swarm-mvp2-brief.md）。
 *
 * 这里只做研究语义：结论、证据、引用关系、路线登记、提交幂等、阶段可见范围。
 * 执行任务的身份与状态仍然只由 DSH 任务板持有（提交落库之后，插件再去完成任务）。
 */

export const BASIS = ["checked_fact", "source_claim", "inference", "observation"] as const;
const MAX_EVIDENCE_PER_SUBMISSION = 20;
const MAX_TEXT = 8000;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export type EvidenceInput = {
  source: Evidence["source"];
  locator: Evidence["locator"];
  access: Evidence["access"];
  how: string;
};

/**
 * 证据去重键：来源（种类 + 标识 + 版本）+ 定位（章节 / 表号 / 图号 + 摘句）。
 * 页码不进键——用户定的是「章节 + 摘句」即可，缺页码不能降级，也不能为凑页码编造。
 */
export function evidenceKey(input: EvidenceInput): string {
  const source = obj(input.source);
  const locator = obj(input.locator);
  const raw = [
    String(source.kind ?? ""),
    String(source.ref ?? ""),
    String(source.version ?? ""),
    String(locator.section ?? ""),
    String(locator.lines ?? ""),
    String(locator.quote ?? ""),
  ].join("\u0001");
  return createHash("sha256").update(raw).digest("hex").slice(0, 40);
}

/** 把工具参数整理成一条证据；缺来源或摘句就拒，不记半条。 */
export function readEvidence(value: unknown): EvidenceInput {
  const input = obj(value);
  const source = obj(input.source);
  const kind = str(source.kind) ?? "other";
  if (!["paper", "web", "code", "data", "proof", "other"].includes(kind))
    throw new ApiFailure("EVIDENCE_INVALID", 400, "证据来源类型不对。");
  const ref = str(source.ref);
  const title = str(source.title);
  if (!ref || !title)
    throw new ApiFailure("EVIDENCE_INVALID", 400, "证据要有来源标识（arXiv 号 / DOI / URL / 资产 id）和标题。");
  const locatorRaw = input.locator === null || input.locator === undefined ? null : obj(input.locator);
  const locator = locatorRaw
    ? {
        ...(Number.isSafeInteger(Number(locatorRaw.page)) && Number(locatorRaw.page) > 0
          ? { page: Number(locatorRaw.page) }
          : {}),
        ...(str(locatorRaw.section) ? { section: str(locatorRaw.section)! } : {}),
        ...(str(locatorRaw.lines) ? { lines: str(locatorRaw.lines)! } : {}),
        ...(str(locatorRaw.quote) ? { quote: str(locatorRaw.quote)!.slice(0, 1200) } : {}),
      }
    : null;
  const access = str(input.access) ?? "full_text";
  if (!["full_text", "abstract_only", "unavailable"].includes(access))
    throw new ApiFailure("EVIDENCE_INVALID", 400, "证据可得性只能是 full_text / abstract_only / unavailable。");
  const how = str(input.how);
  if (!how) throw new ApiFailure("EVIDENCE_INVALID", 400, "证据要写清怎么拿到的（检索 / 下载 / 实测）。");
  return {
    source: {
      kind: kind as Evidence["source"]["kind"],
      title: title.slice(0, 300),
      ref: ref.slice(0, 300),
      ...(str(source.assetId) ? { assetId: str(source.assetId)! } : {}),
      ...(str(source.version) ? { version: str(source.version)! } : {}),
    },
    locator,
    access: access as Evidence["access"],
    how: how.slice(0, 300),
  };
}

/** 结论的可见范围：前 2 轮独立探索，只对负责人和审查者开放。 */
export function visibilityFor(round: number): Claim["visibility"] {
  return round <= 2 ? "lead_reviewers" : "all";
}

type Client = pg.PoolClient;

export type SubmissionResult = {
  submissionId: string;
  claimIds: string[];
  evidenceIds: string[];
  postIds: string[];
  repeated?: boolean;
};

/** 按 submission_id 幂等：命中就原样返回上一次的结果。 */
export async function findSubmission(
  client: Client,
  account: string,
  runId: string,
  submissionId: string,
): Promise<SubmissionResult | null> {
  const row = (
    await client.query(
      "select result from swarm_submission where account_id=$1 and run_id=$2 and submission_id=$3",
      [account, runId, submissionId],
    )
  ).rows[0];
  return row ? ({ ...(row.result as SubmissionResult), repeated: true } as SubmissionResult) : null;
}

export async function recordSubmission(
  client: Client,
  input: {
    account: string;
    runId: string;
    submissionId: string;
    member: string;
    kind: string;
    result: SubmissionResult;
  },
): Promise<void> {
  await client.query(
    `insert into swarm_submission(account_id,run_id,submission_id,member,kind,result)
     values($1,$2,$3,$4,$5,$6)`,
    [input.account, input.runId, input.submissionId, input.member, input.kind, JSON.stringify(input.result)],
  );
}

/**
 * 记一条证据；同来源 + 同版本 + 同定位已经有就复用那一条（引用关系另外记）。
 * 返回证据 id 和它是不是新记的。
 */
export async function putEvidence(
  client: Client,
  input: { account: string; runId: string; submissionId: string; evidence: EvidenceInput },
): Promise<{ id: string; created: boolean; evidence: Evidence }> {
  const key = evidenceKey(input.evidence);
  const existing = (
    await client.query(
      "select id from swarm_evidence where account_id=$1 and run_id=$2 and dedupe_key=$3",
      [input.account, input.runId, key],
    )
  ).rows[0];
  if (existing)
    return {
      id: String(existing.id),
      created: false,
      evidence: {
        id: String(existing.id),
        ...input.evidence,
      },
    };
  const id = randomUUID();
  await client.query(
    `insert into swarm_evidence(id,account_id,run_id,submission_id,source,locator,access,how,dedupe_key)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      input.account,
      input.runId,
      input.submissionId,
      JSON.stringify(input.evidence.source),
      input.evidence.locator ? JSON.stringify(input.evidence.locator) : null,
      input.evidence.access,
      input.evidence.how,
      key,
    ],
  );
  return { id, created: true, evidence: { id, ...input.evidence } };
}

export type ClaimInput = {
  text: string;
  conditions: string[];
  basis: Basis;
  claimId?: string | null;
  negative?: Claim["negative"];
};

export function readClaim(value: unknown): ClaimInput {
  const input = obj(value);
  const text = str(input.text);
  if (!text || text.length < 8)
    throw new ApiFailure("CLAIM_INVALID", 400, "结论要写清楚具体主张（一句话也行，但不能空）。");
  const basis = str(input.basis) ?? "inference";
  if (!(BASIS as readonly string[]).includes(basis))
    throw new ApiFailure("CLAIM_INVALID", 400, "依据只能是 checked_fact / source_claim / inference / observation。");
  const negativeRaw = input.negative === undefined || input.negative === null ? null : obj(input.negative);
  const negative = negativeRaw
    ? {
        searched: str(negativeRaw.searched) ?? "",
        scope: str(negativeRaw.scope) ?? "",
        notFound: str(negativeRaw.notFound) ?? "",
      }
    : null;
  if (negative && (!negative.searched || !negative.notFound))
    throw new ApiFailure("CLAIM_INVALID", 400, "负结果要写清找过什么、没找到什么。");
  return {
    text: text.slice(0, MAX_TEXT),
    conditions: list(input.conditions).map((entry) => String(entry).slice(0, 300)).slice(0, 12),
    basis: basis as Basis,
    claimId: str(input.claimId),
    negative,
  };
}

/** 写一条结论（新版本或首版），并把引用的证据挂上。 */
export async function putClaim(
  client: Client,
  input: {
    account: string;
    runId: string;
    submissionId: string;
    member: string;
    taskId: string | null;
    routeId: string | null;
    round: number;
    claim: ClaimInput;
    evidenceIds: string[];
  },
): Promise<{ claim: Claim; created: boolean }> {
  // 结论要么引用至少一条证据，要么明确是负结果（PRD §5：空泛进度不能充当交付）。
  if (!input.evidenceIds.length && !input.claim.negative)
    throw new ApiFailure(
      "CLAIM_NEEDS_EVIDENCE",
      400,
      "结论要引用至少一条证据（把 evidence 一起交上来），或者写成负结果（找过什么、没找到什么）。",
    );
  const visibility = visibilityFor(input.round);
  let id = input.claim.claimId ?? randomUUID();
  let version = 1;
  if (input.claim.claimId) {
    const prior = (
      await client.query(
        "select max(version) v from swarm_claim where account_id=$1 and run_id=$2 and id=$3",
        [input.account, input.runId, input.claim.claimId],
      )
    ).rows[0]?.v;
    if (prior === null || prior === undefined)
      throw new ApiFailure("CLAIM_NOT_FOUND", 404, "要改的结论不存在。");
    version = Number(prior) + 1;
  }
  await client.query(
    `insert into swarm_claim(
       account_id,run_id,id,submission_id,version,text,conditions,basis,status,author,task_id,route_id,round,visibility,negative
     ) values($1,$2,$3,$4,$5,$6,$7,$8,'candidate',$9,$10,$11,$12,$13,$14)`,
    [
      input.account,
      input.runId,
      id,
      input.submissionId,
      version,
      input.claim.text,
      JSON.stringify(input.claim.conditions),
      input.claim.basis,
      input.member,
      input.taskId,
      input.routeId,
      input.round,
      visibility,
      input.claim.negative ? JSON.stringify(input.claim.negative) : null,
    ],
  );
  for (const evidenceId of input.evidenceIds)
    await client.query(
      `insert into swarm_claim_evidence(account_id,run_id,claim_id,claim_version,evidence_id)
       values($1,$2,$3,$4,$5)`,
      [input.account, input.runId, id, version, evidenceId],
    );
  return {
    created: true,
    claim: {
      id,
      version,
      text: input.claim.text,
      conditions: input.claim.conditions,
      basis: input.claim.basis,
      status: "candidate",
      evidenceIds: input.evidenceIds,
      author: input.member,
      taskId: input.taskId ?? "",
      routeId: input.routeId,
      submissionId: input.submissionId,
      round: input.round,
      reviews: [],
      refuteRounds: 0,
      visibility,
      negative: input.claim.negative ?? null,
    },
  };
}

/** 读一条结论的指定版本（默认最新版）。 */
export async function loadClaim(
  client: Client,
  account: string,
  runId: string,
  claimId: string,
  version?: number,
): Promise<Claim> {
  const row = (
    await client.query(
      `select * from swarm_claim
        where account_id=$1 and run_id=$2 and id=$3
          and ($4::int is null or version=$4)
        order by version desc limit 1`,
      [account, runId, claimId, version ?? null],
    )
  ).rows[0];
  if (!row) throw new ApiFailure("CLAIM_NOT_FOUND", 404, "这条结论不存在。");
  return claimRow(row);
}

export function claimRow(row: Record<string, unknown>): Claim {
  return {
    id: String(row.id),
    version: Number(row.version),
    text: String(row.text),
    conditions: Array.isArray(row.conditions) ? (row.conditions as string[]) : [],
    basis: row.basis as Claim["basis"],
    status: row.status as ClaimStatus,
    ...(row.status_reason ? { statusReason: String(row.status_reason) } : {}),
    evidenceIds: [],
    author: String(row.author),
    taskId: row.task_id ? String(row.task_id) : "",
    routeId: row.route_id ? String(row.route_id) : null,
    submissionId: String(row.submission_id),
    round: Number(row.round),
    reviews: [],
    refuteRounds: Number(row.refute_rounds ?? 0),
    visibility: row.visibility as Claim["visibility"],
    negative: (row.negative as Claim["negative"]) ?? null,
  };
}

export function evidenceRow(row: Record<string, unknown>): Evidence {
  return {
    id: String(row.id),
    source: row.source as Evidence["source"],
    locator: (row.locator as Evidence["locator"]) ?? null,
    access: row.access as Evidence["access"],
    how: String(row.how),
  };
}

/** 结论引用了哪些证据（按版本）。 */
export async function claimEvidenceIds(
  client: Client,
  account: string,
  runId: string,
  claimId: string,
  version: number,
): Promise<string[]> {
  const rows = (
    await client.query(
      `select evidence_id from swarm_claim_evidence
        where account_id=$1 and run_id=$2 and claim_id=$3 and claim_version=$4`,
      [account, runId, claimId, version],
    )
  ).rows;
  return rows.map((row) => String(row.evidence_id));
}

/** 每条结论最新版本 + 引用关系，一次读出来（快照 / 查询都用它）。 */
export async function latestClaims(
  client: Client,
  account: string,
  runId: string,
  filter: {
    routeId?: string | null;
    taskId?: string | null;
    /** 独立阶段裁剪：只给这些路线的结论（null = 不裁）。 */
    routes?: string[] | null;
    sinceVersion?: number;
    limit?: number;
  } = {},
): Promise<Claim[]> {
  const rows = (
    await client.query(
      `select distinct on (c.id) c.* from swarm_claim c
        where c.account_id=$1 and c.run_id=$2
          and ($3::text is null or c.route_id=$3)
          and ($4::text is null or c.task_id=$4)
          and ($5::text[] is null or c.route_id = any($5::text[]) or c.route_id is null)
        order by c.id, c.version desc`,
      [
        account,
        runId,
        filter.routeId ?? null,
        filter.taskId ?? null,
        filter.routes ?? null,
      ],
    )
  ).rows.map(claimRow);
  const links = (
    await client.query(
      `select claim_id, claim_version, evidence_id from swarm_claim_evidence
        where account_id=$1 and run_id=$2`,
      [account, runId],
    )
  ).rows;
  const byKey = new Map<string, string[]>();
  for (const link of links) {
    const key = `${link.claim_id}:${link.claim_version}`;
    byKey.set(key, [...(byKey.get(key) ?? []), String(link.evidence_id)]);
  }
  const claims = rows.map((claim) => ({
    ...claim,
    evidenceIds: byKey.get(`${claim.id}:${claim.version}`) ?? [],
  }));
  const filtered =
    filter.sinceVersion === undefined || filter.sinceVersion === null
      ? claims
      : claims.filter((claim) => claim.version > filter.sinceVersion!);
  return filtered
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, Math.min(Math.max(filter.limit ?? 50, 1), 200));
}

/** 证据全量（按 run），可按 id 列表过滤。 */
export async function loadEvidence(
  client: Client,
  account: string,
  runId: string,
  ids?: string[],
): Promise<Evidence[]> {
  const rows = (
    await client.query(
      `select * from swarm_evidence
        where account_id=$1 and run_id=$2 and ($3::uuid[] is null or id = any($3::uuid[]))
        order by created_at`,
      [account, runId, ids && ids.length ? ids : null],
    )
  ).rows;
  return rows.map(evidenceRow);
}

/**
 * 阶段结果的汇总（MVP-2：核实还没接通，所以没有 verified，也没有正式报告）。
 * 只按当前标签说清楚：哪些是候选、哪些是负结果、还缺什么。
 */
export async function buildReport(
  client: Client,
  input: { account: string; runId: string; version: number; stateReason?: string | null },
): Promise<SwarmReport> {
  const claims = await latestClaims(client, input.account, input.runId, { limit: 200 });
  const evidence = await loadEvidence(client, input.account, input.runId);
  const usedEvidence = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const routes = (
    await client.query(
      "select route_id,title,state,gap,blocked_reason from swarm_approach where account_id=$1 and run_id=$2",
      [input.account, input.runId],
    )
  ).rows;
  const gaps = [
    ...routes
      .filter((route) => route.gap || route.blocked_reason)
      .map((route) => `${String(route.title)}：${String(route.gap ?? route.blocked_reason)}`),
    ...(input.stateReason ? [input.stateReason] : []),
    "核实还没接通，所有结论都只是候选",
  ];
  return {
    version: input.version,
    state: "stage",
    answer: null,
    verified: [],
    limits: ["核实还没接通：以下全部是候选，不能当作已证实的结论对外使用"],
    disputed: [],
    unverified: claims.map((claim) => claim.id),
    negative: claims.filter((claim) => claim.negative).map((claim) => claim.id),
    gaps: [...new Set(gaps)].slice(0, 20),
    sources: [...usedEvidence].filter((id) => evidence.some((entry) => entry.id === id)),
    nextSuggestion: null,
    updatedAt: new Date().toISOString(),
  };
}

// ── 路线登记 ───────────────────────────────────────
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：,.;:!?！？（）()《》“”"'’]/g, "");

export type ApproachInput = {
  routeId?: string | null;
  title: string;
  idea: string;
  approachFamily: string;
  tags: string[];
  state?: SwarmApproach["state"];
  gap?: string | null;
  blockedReason?: string | null;
  reopenReason?: string | null;
  mergedInto?: string | null;
};

export function readApproach(value: unknown): ApproachInput {
  const input = obj(value);
  const title = str(input.title);
  if (!title) throw new ApiFailure("APPROACH_INVALID", 400, "路线要有名字。");
  const state = str(input.state) ?? undefined;
  if (state && !["active", "blocked", "stopped", "reopened", "merged"].includes(state))
    throw new ApiFailure("APPROACH_INVALID", 400, "路线状态不对。");
  return {
    routeId: str(input.routeId),
    title: title.slice(0, 200),
    idea: (str(input.idea) ?? "").slice(0, 1000),
    approachFamily: (str(input.approachFamily) ?? title).slice(0, 120),
    tags: list(input.tags).map((tag) => String(tag).slice(0, 60)).slice(0, 8),
    ...(state ? { state: state as SwarmApproach["state"] } : {}),
    gap: str(input.gap),
    blockedReason: str(input.blockedReason),
    reopenReason: str(input.reopenReason),
    mergedInto: str(input.mergedInto),
  };
}

/**
 * 登记路线：认识同一条（方法族 + 标题归一化后相同）就不再新开一条；
 * 要重开一条阻塞的路线，必须写明新机制（PRD §4：只有登记具体新机制才可重新投入）。
 */
export async function putApproach(
  client: Client,
  input: { account: string; runId: string; approach: ApproachInput },
): Promise<{ route: SwarmApproach; created: boolean }> {
  const { account, runId, approach } = input;
  const existing = (
    await client.query(
      "select * from swarm_approach where account_id=$1 and run_id=$2",
      [account, runId],
    )
  ).rows.map((row) => ({
    routeId: String(row.route_id),
    title: String(row.title),
    idea: String(row.idea),
    approachFamily: String(row.approach_family),
    tags: (row.tags as string[]) ?? [],
    state: row.state as SwarmApproach["state"],
    gap: row.gap ? String(row.gap) : undefined,
    blockedReason: row.blocked_reason ? String(row.blocked_reason) : undefined,
    reopenReason: row.reopen_reason ? String(row.reopen_reason) : undefined,
  }));
  const wanted = approach.routeId
    ? existing.find((route) => route.routeId === approach.routeId)
    : existing.find(
        (route) =>
          normalize(route.approachFamily) === normalize(approach.approachFamily) &&
          (normalize(route.title) === normalize(approach.title) ||
            normalize(route.idea) === normalize(approach.idea)),
      );
  const routeId = wanted?.routeId ?? approach.routeId ?? `r-${existing.length + 1}`;
  const reopening = wanted?.state === "blocked" || wanted?.state === "stopped";
  if (reopening && !approach.reopenReason)
    throw new ApiFailure(
      "APPROACH_REOPEN_REASON_REQUIRED",
      400,
      "这条路线是阻塞/停止的；要重开必须写明新机制（reopen_reason），空泛的进度不算。",
    );
  if (approach.state === "blocked" && !approach.blockedReason && !approach.gap)
    throw new ApiFailure("APPROACH_BLOCKED_REASON_REQUIRED", 400, "标阻塞要写清卡在哪（blocked_reason 或 gap）。");
  const state = approach.state ?? (reopening ? "reopened" : "active");
  const next: SwarmApproach = {
    id: routeId,
    title: approach.title,
    idea: approach.idea,
    approachFamily: approach.approachFamily,
    tags: approach.tags,
    state,
    ...(approach.gap ? { gap: approach.gap } : {}),
    ...(approach.blockedReason ? { blockedReason: approach.blockedReason } : {}),
    ...(approach.reopenReason ? { reopenReason: approach.reopenReason } : {}),
    taskIds: [],
    memberIds: [],
  };
  const version = wanted
    ? Number(
        (
          await client.query(
            "select version from swarm_approach where account_id=$1 and run_id=$2 and route_id=$3",
            [account, runId, routeId],
          )
        ).rows[0]?.version ?? 1,
      ) + 1
    : 1;
  await client.query(
    `insert into swarm_approach(
       account_id,run_id,route_id,title,idea,approach_family,tags,state,gap,blocked_reason,reopen_reason,merged_into,version
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (account_id,run_id,route_id) do update set
       title=excluded.title, idea=excluded.idea, approach_family=excluded.approach_family,
       tags=excluded.tags, state=excluded.state,
       -- 没给的缺口 / 阻塞原因要保留：重开一条路线不该把记下来的缺口冲掉。
       gap=coalesce(excluded.gap, swarm_approach.gap),
       blocked_reason=coalesce(excluded.blocked_reason, swarm_approach.blocked_reason),
       reopen_reason=coalesce(excluded.reopen_reason, swarm_approach.reopen_reason),
       merged_into=coalesce(excluded.merged_into, swarm_approach.merged_into),
       version=excluded.version, updated_at=now()`,
    [
      account,
      runId,
      routeId,
      next.title,
      next.idea,
      next.approachFamily,
      JSON.stringify(next.tags),
      next.state,
      approach.gap ?? null,
      approach.blockedReason ?? null,
      approach.reopenReason ?? null,
      approach.mergedInto ?? null,
      version,
    ],
  );
  return { route: next, created: !wanted };
}

/** 读全部登记的路线（快照合并用）。 */
export async function loadApproaches(
  client: Client,
  account: string,
  runId: string,
): Promise<SwarmApproach[]> {
  const rows = (
    await client.query(
      "select * from swarm_approach where account_id=$1 and run_id=$2 order by created_at",
      [account, runId],
    )
  ).rows;
  return rows.map((row) => ({
    id: String(row.route_id),
    title: String(row.title),
    idea: String(row.idea),
    approachFamily: String(row.approach_family),
    tags: (row.tags as string[]) ?? [],
    state: row.state as SwarmApproach["state"],
    ...(row.gap ? { gap: String(row.gap) } : {}),
    ...(row.blocked_reason ? { blockedReason: String(row.blocked_reason) } : {}),
    ...(row.reopen_reason ? { reopenReason: String(row.reopen_reason) } : {}),
    taskIds: [],
    memberIds: [],
  }));
}

export { MAX_EVIDENCE_PER_SUBMISSION };
