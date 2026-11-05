import { createHash, randomUUID } from "node:crypto";
import { buildCoverage, coverageGaps } from "./coverage";
import type pg from "pg";
import type {
  Claim,
  ClaimStatus,
  Evidence,
  Review,
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
  /** 来路；不填就按控制面见过的网址自动判（search / citation / known-url）。 */
  discovery?: Evidence["discovery"] | null;
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
  /** 审查类提交回带这条 review。 */
  reviewId?: string;
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
/** 把 ref / 网址归一成可以互相比较的形状（去协议、去尾斜杠、小写）。 */
function normalizeRef(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .split("?")[0] ?? "";
}

/**
 * 判这条证据的来路（18 广度返工）：
 * - 网址在「搜索结果」里出现过 → search；
 * - 网址在「已抓页面里的外链」里出现过 → citation；
 * - 都没有 → known-url（早就知道、直接抓的）。
 * 只看控制面自己记的转发记录，不问模型「你是怎么找到的」。
 */
export async function inferDiscovery(
  client: Client,
  account: string,
  runId: string,
  source: Evidence["source"],
): Promise<Evidence["discovery"]> {
  const ref = normalizeRef([source.ref, source.assetId].filter(Boolean).join(" "));
  if (!ref) return "known-url";
  const hits = (
    await client.query(
      "select url, kind from swarm_source_hit where account_id=$1 and run_id=$2",
      [account, runId],
    )
  ).rows as Array<{ url: string; kind: string }>;
  const match = (kind: string) =>
    hits.some((hit) => {
      const url = normalizeRef(String(hit.url));
      if (hit.kind !== kind || !url) return false;
      return ref.includes(url) || url.includes(ref);
    });
  if (match("search")) return "search";
  if (match("citation")) return "citation";
  return "known-url";
}

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
  if (existing) {
    const { discovery: ignoredDiscovery, ...rest } = input.evidence;
    void ignoredDiscovery;
    return {
      id: String(existing.id),
      created: false,
      evidence: { id: String(existing.id), ...rest },
    };
  }
  const id = randomUUID();
  const discovery =
    input.evidence.discovery ?? (await inferDiscovery(client, input.account, input.runId, input.evidence.source));
  await client.query(
    `insert into swarm_evidence(id,account_id,run_id,submission_id,source,locator,access,how,dedupe_key,discovery)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
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
      discovery ?? null,
    ],
  );
  const { discovery: ignoredExplicit, ...evidenceRest } = input.evidence;
  void ignoredExplicit;
  return {
    id,
    created: true,
    evidence: { id, ...evidenceRest, ...(discovery ? { discovery } : {}) },
  };
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
  // 改版就是新主张：旧的核实不再作数（status 回到候选，门禁看 verified_version 是否等于当前版本）。
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

/** 一条结论当前的核实绑定（门禁只认版本相等的）。 */
export function verifiedVersionOf(row: Record<string, unknown>): number | null {
  const value = row.verified_version;
  return value === null || value === undefined ? null : Number(value);
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
    ...(row.discovery ? { discovery: String(row.discovery) as Evidence["discovery"] } : {}),
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
    /** 只看这个时间点之后创建的结论（增量读黑板的游标）。 */
    sinceAt?: Date | null;
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
          and ($6::timestamptz is null or c.created_at > $6::timestamptz)
        order by c.id, c.version desc`,
      [
        account,
        runId,
        filter.routeId ?? null,
        filter.taskId ?? null,
        filter.routes ?? null,
        filter.sinceAt ?? null,
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
  // 审查 id 也一并带上（跨版本）：页面不打开详情也能看「这条有几条审查」。
  const reviews = (
    await client.query(
      `select claim_id, id from swarm_review
        where account_id=$1 and run_id=$2 order by created_at`,
      [account, runId],
    )
  ).rows;
  const reviewsByClaim = new Map<string, string[]>();
  for (const review of reviews) {
    const key = String(review.claim_id);
    reviewsByClaim.set(key, [...(reviewsByClaim.get(key) ?? []), String(review.id)]);
  }
  const claims = rows.map((claim) => ({
    ...claim,
    evidenceIds: byKey.get(`${claim.id}:${claim.version}`) ?? [],
    reviews: reviewsByClaim.get(claim.id) ?? [],
  }));
  const filtered =
    filter.sinceVersion === undefined || filter.sinceVersion === null
      ? claims
      : claims.filter((claim) => claim.version > filter.sinceVersion!);
  return filtered
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .slice(0, Math.min(Math.max(filter.limit ?? 50, 1), 200));
}

/**
 * 证据（按 run）。给了 id 列表就严格按它取：空数组就是「没有证据」，
 * 不能退化成「把整块黑板的证据都带回来」（负结果结论踩过）。
 */
export async function loadEvidence(
  client: Client,
  account: string,
  runId: string,
  ids?: string[],
): Promise<Evidence[]> {
  if (ids !== undefined && ids.length === 0) return [];
  const rows = (
    await client.query(
      `select * from swarm_evidence
        where account_id=$1 and run_id=$2 and ($3::uuid[] is null or id = any($3::uuid[]))
        order by created_at`,
      [account, runId, ids ?? null],
    )
  ).rows;
  return rows.map(evidenceRow);
}

/**
 * 汇总 / 正式报告（PRD §5 末的门禁）。
 *
 * 正文只放「绑定了当前版本独立核实」的结论；其余分别进局限、争议、未核实、缺口。
 * 运行还在跑 → stage；结束但有分歧 → awaiting_review；有已核实 → final（无遗留问题）
 * 或 partial（还有候选/缺口）；一条核实都没有 → unresolved。
 */
export async function buildReport(
  client: Client,
  input: {
    account: string;
    runId: string;
    version: number;
    stateReason?: string | null;
    /** 运行状态：决定 stage / awaiting_review / final 等。 */
    runState?: string | null;
    /** 成稿（负责人写的那份贯穿全局的报告）；没有就是 null。 */
    narrative?: string | null;
    limits?: { rounds: number; minutes: number } | null;
    used?: { rounds: number; activeMs: number } | null;
  },
): Promise<SwarmReport> {
  const claims = await latestClaims(client, input.account, input.runId, { limit: 200 });
  const evidence = await loadEvidence(client, input.account, input.runId);
  const usedEvidence = new Set(claims.flatMap((claim) => claim.evidenceIds));
  const verifiedRows = (
    await client.query(
      `select id, version, text, verified_version, evidence_count from (
         select c.id, c.version, c.text, c.verified_version, c.author,
                (select count(*) from swarm_claim_evidence l
                  where l.account_id=c.account_id and l.run_id=c.run_id
                    and l.claim_id=c.id and l.claim_version=c.version) evidence_count
           from swarm_claim c
          where c.account_id=$1 and c.run_id=$2
            and c.verified_version = c.version
            and c.status = 'verified'
            -- 只看每条结论的最新版本：改版之后旧版本的核实不算数。
            and c.version = (select max(c2.version) from swarm_claim c2
                              where c2.account_id=c.account_id and c2.run_id=c.run_id and c2.id=c.id)
       ) v
       -- 正文优先「针对研究问题本身的主张」：汇总 / 进度类（核实员的独立核实汇总、
       -- 负责人的阶段性小结）排在后面，只有没有具体发现时才用它。
       order by
         case when v.author in ('lead', 'verifier') then 1 else 0 end,
         case when v.text ~ '^(独立核实汇总|核实汇总|本批|阶段小结|进度|本轮汇总)' then 1 else 0 end,
         evidence_count desc, version desc`,
      [input.account, input.runId],
    )
  ).rows;
  const verifiedIds = new Set(verifiedRows.map((row) => String(row.id)));
  const disputed = claims.filter(
    (claim) => (claim.status === "disputed" || claim.status === "falsified") && !verifiedIds.has(claim.id),
  );
  const insufficient = claims.filter((claim) => claim.status === "insufficient");
  const unverified = claims.filter(
    (claim) =>
      !verifiedIds.has(claim.id) &&
      claim.status !== "disputed" &&
      claim.status !== "falsified" &&
      claim.status !== "insufficient" &&
      !claim.negative,
  );
  const negative = claims.filter((claim) => claim.negative);
  const routes = (
    await client.query(
      "select route_id,title,state,gap,blocked_reason from swarm_approach where account_id=$1 and run_id=$2",
      [input.account, input.runId],
    )
  ).rows;
  const gaps = [
    ...routes
      // 合并掉的路线不是缺口；「与 r3 同一条路线，重复登记」这类说明也不是。
      .filter((route) => route.state !== "merged")
      .filter((route) => route.gap || route.blocked_reason)
      .map((route) => `${String(route.title)}：${String(route.gap ?? route.blocked_reason)}`)
      .filter((line) => !/(重复登记|已并入|同一条路线)/.test(line)),
    ...insufficient.map((claim) => `证据不足：${claim.text.slice(0, 80)}（${claim.statusReason ?? "未说明"}）`),
    // 覆盖缺口（18 广度返工）：结论里提到、但没有任何证据指向的名字。
    ...coverageGaps(
      buildCoverage({
        routes: routes.map((route) => ({ id: String(route.id), title: String(route.title ?? "") })),
        claims: claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          routeId: claim.routeId,
          evidenceIds: claim.evidenceIds,
        })),
        evidence: [...evidence.values()].map((entry) => ({
          id: entry.id,
          claimIds: [],
          source: { title: entry.source.title, ref: entry.source.ref },
          locator: entry.locator,
        })),
      }),
    ),
    ...(input.stateReason ? [input.stateReason] : []),
  ];
  const limits = [
    ...disputed.map((claim) => `有争议/已证伪：${claim.text.slice(0, 80)}`),
    ...insufficient.map((claim) => `待补证据：${claim.text.slice(0, 60)}`),
    ...claims
      .flatMap((claim) => claim.conditions ?? [])
      .slice(0, 8)
      .map((condition) => `适用条件：${condition}`),
  ];
  const running = input.runState === "running" || input.runState === "near_limit" || input.runState === "finishing";
  const state: SwarmReport["state"] = running
    ? "stage"
    : input.runState === "awaiting_review"
      ? "awaiting_review"
      : verifiedRows.length === 0
        ? "unresolved"
        : gaps.length || unverified.length || negative.length || limits.length
          ? "partial"
          : "final";
  // 到限时的追加建议：说清新发现、剩余缺口、建议追加多少（PRD §3）。
  const nearLimit =
    !!input.limits &&
    !!input.used &&
    ((input.used.activeMs ?? 0) >= input.limits.minutes * 60_000 * 0.8 ||
      (input.used.rounds ?? 0) >= input.limits.rounds);
  // 到限停下来的运行也要留着追加建议：用户正是看着它决定要不要追加
  // （PRD §3「到限时给出追加建议」；追加卡在第二批）。只有已经收尾成正式报告的
  // final 才不再建议追加。
  const nextSuggestion =
    nearLimit && state !== "final"
      ? {
          rounds: 2,
          minutes: Math.max(15, Math.round(input.limits!.minutes / 2)),
          why: [
            `已经有 ${verifiedIds.size} 条结论通过独立核实，还有 ${unverified.length} 条候选没核`,
            gaps.length
              ? `剩余缺口：${gaps
                  .slice(0, 2)
                  .map((gap) => gap.slice(0, 60))
                  .join("；")}`
              : "剩余缺口：暂时没有新的",
          ].join("；"),
        }
      : null;
  return {
    version: input.version,
    state,
    answer: verifiedRows[0] ? String(verifiedRows[0].text).slice(0, 2000) : null,
    verified: verifiedRows.map((row) => String(row.id)),
    limits: [...new Set(limits)].slice(0, 12),
    disputed: disputed.map((claim) => claim.id),
    unverified: unverified.map((claim) => claim.id),
    negative: negative.map((claim) => claim.id),
    gaps: [...new Set(gaps)].slice(0, 20),
    sources: [...usedEvidence].filter((id) => evidence.some((entry) => entry.id === id)),
    // 按来路统计（18 广度返工）：页面显示「发现类 search / 共 M」。
    discoveryCounts: (() => {
      const counts = { search: 0, knownUrl: 0, citation: 0, unknown: 0 };
      for (const entry of evidence) {
        if (entry.discovery === "search") counts.search += 1;
        else if (entry.discovery === "known-url") counts.knownUrl += 1;
        else if (entry.discovery === "citation") counts.citation += 1;
        else counts.unknown += 1;
      }
      return counts;
    })(),
    nextSuggestion,
    narrative: input.narrative ?? null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 第 3 轮起的精简 Context Packet（PRD §4）：只转已核实和明确标明的成果，
 * 一条一句：结论、适用条件、来源定位。不转整段会话，也不转别人的工作目录。
 */
export async function contextPacket(
  client: Client,
  input: { account: string; runId: string },
): Promise<string> {
  const verified = (
    await client.query(
      `select c.id, c.text, c.route_id, c.conditions from swarm_claim c
        where c.account_id=$1 and c.run_id=$2 and c.verified_version = c.version and c.status='verified'
        order by c.created_at limit 8`,
      [input.account, input.runId],
    )
  ).rows;
  const negative = (
    await client.query(
      `select distinct on (c.id) c.id, c.text, c.negative from swarm_claim c
        where c.account_id=$1 and c.run_id=$2 and c.negative is not null
        order by c.id, c.version desc limit 5`,
      [input.account, input.runId],
    )
  ).rows;
  const links = (
    await client.query(
      `select l.claim_id, l.claim_version, e.source from swarm_claim_evidence l
         join swarm_evidence e
           on e.account_id=l.account_id and e.run_id=l.run_id and e.id=l.evidence_id
        where l.account_id=$1 and l.run_id=$2`,
      [input.account, input.runId],
    )
  ).rows;
  const sourceOf = (claimId: string, claimVersion: number | null) => {
    const link = links.find(
      (row) => String(row.claim_id) === claimId && (!claimVersion || Number(row.claim_version) === claimVersion),
    );
    if (!link) return "";
    const source = link.source as { ref?: string; title?: string };
    return `（来源 ${source?.ref ?? "未注明"}${source?.title ? " " + String(source.title).slice(0, 40) : ""}）`;
  };
  if (!verified.length && !negative.length) return "";
  const lines = [
    "第 3 轮起可以互相借鉴了。下面是已经过独立核实的结论和明确标明的负结果，只能引用这些版本，不要转述别人的原话：",
    ...verified.map(
      (row, index) =>
        `${index + 1}. [已核实] ${String(row.text).slice(0, 200)}` +
        `${Array.isArray(row.conditions) && row.conditions.length ? `｜条件：${(row.conditions as string[]).slice(0, 3).join("、")}` : ""}` +
        `｜路线 ${String(row.route_id ?? "未标")}${sourceOf(String(row.id), null)}`,
    ),
    ...negative.map(
      (row, index) =>
        `${verified.length + index + 1}. [负结果] ${String(row.text).slice(0, 160)}${
          row.negative
            ? `｜找过：${String((row.negative as { searched?: string }).searched ?? "").slice(0, 60)}；没找到：${String((row.negative as { notFound?: string }).notFound ?? "").slice(0, 60)}`
            : ""
        }`,
    ),
    "未核实的候选不要当成结论引用；要引用别人的东西，先自己在黑板上查它当前版本。",
  ];
  return lines.join("\n");
}

// ── 审查（反驳 / 补证据 / 核实 / 降级）───────────────

export const REVIEW_KINDS = ["refute", "need_evidence", "verify", "downgrade"] as const;
export const REVIEW_VERDICTS = ["upheld", "rejected", "verified", "not_verifiable", "pending"] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** 每条结论最多两轮反驳：改版本不重置计数（PRD §5）。 */
export const MAX_REFUTE_ROUNDS = 2;

export type ReviewInput = {
  claimId: string;
  claimVersion?: number | null;
  kind: ReviewKind;
  verdict: ReviewVerdict;
  reason: string;
  evidenceIds: string[];
  taskId: string | null;
  /** 核实者读原文的完整性（否定式结论的门禁用它）。 */
  readCompleteness?: "full" | "partial" | null;
};

export function readReview(value: unknown): ReviewInput {
  const input = obj(value);
  const claimId = str(input.claimId);
  if (!claimId) throw new ApiFailure("CLAIM_NOT_FOUND", 404, "要审的是哪条结论？");
  const kind = str(input.kind) ?? "verify";
  if (!(REVIEW_KINDS as readonly string[]).includes(kind))
    throw new ApiFailure("REVIEW_INVALID", 400, "审查类型只能是 refute / need_evidence / verify / downgrade。");
  const verdict = str(input.verdict) ?? (kind === "verify" ? "verified" : "upheld");
  if (!(REVIEW_VERDICTS as readonly string[]).includes(verdict))
    throw new ApiFailure("REVIEW_INVALID", 400, "判定只能是 upheld / rejected / verified / not_verifiable / pending。");
  const reason = str(input.reason);
  if (!reason || reason.length < 4)
    throw new ApiFailure("REVIEW_REASON_REQUIRED", 400, "审查要写清理由：看到了什么、为什么这样判。");
  const completeness = str(input.readCompleteness);
  if (completeness && completeness !== "full" && completeness !== "partial")
    throw new ApiFailure("REVIEW_INVALID", 400, "read_completeness 只能是 full 或 partial。");
  const version = Number(input.claimVersion);
  return {
    claimId,
    claimVersion: Number.isSafeInteger(version) && version > 0 ? version : null,
    kind: kind as ReviewKind,
    verdict: verdict as ReviewVerdict,
    reason: reason.slice(0, 4000),
    evidenceIds: list(input.evidenceIds).map(String).slice(0, 20),
    taskId: str(input.taskId),
    readCompleteness: (completeness as "full" | "partial" | undefined) ?? null,
  };
}

export function reviewRow(row: Record<string, unknown>): Review {
  return {
    id: String(row.id),
    claimId: String(row.claim_id),
    claimVersion: Number(row.claim_version),
    kind: row.kind as Review["kind"],
    by: String(row.by_member),
    reason: String(row.reason),
    evidenceIds: (row.evidence_ids as string[]) ?? [],
    verdict: row.verdict as Review["verdict"],
    round: Number(row.round ?? 0),
    taskId: row.task_id ? String(row.task_id) : "",
    ...(row.read_completeness ? { readCompleteness: String(row.read_completeness) } : {}),
  } as Review;
}

/** 某一版结论上的审查记录（按时间）。 */
export async function loadReviews(
  client: Client,
  account: string,
  runId: string,
  filter: { claimId?: string | null; claimVersion?: number | null } = {},
): Promise<Review[]> {
  const rows = (
    await client.query(
      `select * from swarm_review
        where account_id=$1 and run_id=$2
          and ($3::uuid is null or claim_id=$3)
          and ($4::int is null or claim_version=$4)
        order by created_at limit 200`,
      [account, runId, filter.claimId ?? null, filter.claimVersion ?? null],
    )
  ).rows;
  return rows.map(reviewRow);
}

/** 每条结论的反驳轮次（跨版本累计）。 */
async function refuteRounds(client: Client, account: string, runId: string, claimId: string) {
  const row = (
    await client.query(
      `select count(*)::int n from swarm_review
        where account_id=$1 and run_id=$2 and claim_id=$3 and kind='refute'
          and verdict='upheld'`,
      [account, runId, claimId],
    )
  ).rows[0];
  return Number(row?.n ?? 0);
}

/**
 * 落一条审查并更新结论状态（PRD §5）。
 *
 * 规则：
 * - 反驳和核实都不能由结论作者本人做；核实的人也不能就是那条结论的反驳者。
 * - 核实必须带自己的证据（回原始出处核，不是复述反驳意见）。
 * - 每条结论最多两轮反驳，改版本不重置；两轮之后还有争议就标「有争议」。
 * - 核实绑定版本：改主张或证据后，旧核实不再作数（门禁看 verified_version）。
 */
export async function reviewClaim(
  client: Client,
  input: {
    account: string;
    runId: string;
    member: string;
    round: number;
    submissionId: string;
    review: ReviewInput;
  },
): Promise<{ claim: Claim; review: Review; statusBefore: ClaimStatus }> {
  const { account, runId, member, review } = input;
  const claim = await loadClaim(client, account, runId, review.claimId, review.claimVersion ?? undefined);
  if (claim.author === member)
    throw new ApiFailure(
      "REVIEW_SELF_FORBIDDEN",
      400,
      "不能审自己交的结论：反驳和核实都要由别人做。",
    );
  const rounds = await refuteRounds(client, account, runId, claim.id);
  // 撤回/更正自己那条反驳不算新的一轮：两轮用完也要能收回（D5）。
  const isCorrection = review.kind === "refute" && review.verdict !== "upheld";
  if (review.kind === "refute" && !isCorrection && rounds >= MAX_REFUTE_ROUNDS)
    throw new ApiFailure(
      "REFUTE_ROUNDS_EXHAUSTED",
      400,
      `这条结论已经反驳过 ${rounds} 轮（上限 ${MAX_REFUTE_ROUNDS}），改版本也不重置；还有分歧就按「有争议」呈现，不能写成已证实。`,
    );
  if (review.kind === "verify") {
    const priorRefuter = (
      await client.query(
        `select 1 from swarm_review
          where account_id=$1 and run_id=$2 and claim_id=$3 and kind='refute' and by_member=$4 limit 1`,
        [account, runId, claim.id, member],
      )
    ).rowCount;
    if (priorRefuter)
      throw new ApiFailure(
        "VERIFY_REFUTER_CONFLICT",
        400,
        "反驳和核实要分开人做：你反驳过这条结论，就不能再给它签核实。",
      );
    // 这一版还有没解决的反驳时不能签核实：先改版本（或让反驳者撤回），
    // 否则「已核实」和「有争议」会同时出现在同一条结论上（真机里真出现过）。
    // D5：只看这一版最新的一条反驳。反驳者后来更正（verdict=rejected / withdrawn）就算关闭，
    // 不能因为「旧的那条 upheld 还在表里」把新版本的核实永远挡住。
    const openRefute = (
      await client.query(
        `select by_member, reason, verdict from swarm_review
          where account_id=$1 and run_id=$2 and claim_id=$3 and claim_version=$4
            and kind='refute'
          order by created_at desc
          limit 1`,
        [account, runId, claim.id, claim.version],
      )
    ).rows.find((row) => String(row.verdict) === "upheld");
    if (openRefute)
      throw new ApiFailure(
        "VERIFY_OPEN_REFUTE",
        409,
        `这一版还有没解决的反驳（${String(openRefute.by_member)}：${String(openRefute.reason).slice(0, 80)}）。先改主张或补证据出新版本，或者让反驳者撤回，再核实。`,
      );
    // 核实门禁（17 返工 B2）：**任何**结论，只要核实者自己说读不全 / 核不了 / 打不开，
    // 就不能判「已核实」，只能判 not_verifiable（证据不足）。
    // 依据：PRD §5「回到原始出处去核」——读不全的核实不算核实。
    const incompleteReading = /截断|读不全|没法穷举|未能穷举|无法穷举|只读了摘要|打不开|乱码|核不了|没核到|无法确认全文/.test(
      review.reason,
    );
    if (review.verdict === "verified") {
      if (review.readCompleteness === "partial")
        throw new ApiFailure(
          "VERIFY_NEEDS_FULL_TEXT",
          409,
          "核实自己标了 read_completeness=partial（读不全）：这种情况不能判已核实，请改判 not_verifiable，让结论进「证据不足」。",
        );
      if (incompleteReading)
        throw new ApiFailure(
          "VERIFY_NEEDS_FULL_TEXT",
          409,
          "你写的理由里提到读不全 / 核不了 / 打不开：这种情况不能判已核实，请改判 not_verifiable（证据不足）。",
        );
    }
    // 否定式结论（「X 里没有 Y」）额外要求核实者明确确认读全了原文。
    const negativeClaim = !!claim.negative;
    if (negativeClaim && review.verdict === "verified") {
      if (review.readCompleteness !== "full")
        throw new ApiFailure(
          "VERIFY_NEEDS_FULL_TEXT",
          409,
          "这是否定式结论（某处没有某样东西）：核实要确认自己读全了原文才能判已核实（read_completeness: \"full\"）；读不全就判 not_verifiable，让它进「证据不足」。",
        );
    }
    if (review.evidenceIds.length === 0)
      throw new ApiFailure(
        "VERIFY_EVIDENCE_REQUIRED",
        400,
        "核实要自己回原始出处核：把核到的那条证据（来源 + 章节/表号 + 摘句）一起交上来。",
      );
  }
  const id = randomUUID();
  await client.query(
    `insert into swarm_review(
       account_id,run_id,id,claim_id,claim_version,kind,by_member,reason,evidence_ids,verdict,round,task_id,submission_id,read_completeness
     ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      account,
      runId,
      id,
      claim.id,
      claim.version,
      review.kind,
      member,
      review.reason,
      JSON.stringify(review.evidenceIds),
      review.verdict,
      input.round,
      review.taskId,
      input.submissionId,
      review.readCompleteness ?? null,
    ],
  );
  const statusBefore = claim.status;
  // 状态机：候选 →（独立反驳）→ 待核实 →（独立核实）→ 已核实；反驳成立→有争议。
  let status: ClaimStatus = claim.status;
  let statusReason: string | null = claim.statusReason ?? null;
  let verifiedVersion: number | null = null;
  let verifiedBy: string | null = null;
  if (review.kind === "verify") {
    if (review.verdict === "verified") {
      status = "verified";
      statusReason = null;
      verifiedVersion = claim.version;
      verifiedBy = member;
    } else if (review.verdict === "not_verifiable") {
      status = "insufficient";
      statusReason = `核实未能成立：${review.reason.slice(0, 200)}`;
    }
  } else if (review.kind === "refute" && review.verdict === "upheld") {
    status = "disputed";
    statusReason = review.reason.slice(0, 400);
  } else if (review.kind === "refute" && review.verdict === "rejected") {
    status = "awaiting_verify";
    statusReason = "反驳没有成立，等独立核实";
  } else if (review.kind === "need_evidence") {
    status = "insufficient";
    statusReason = `需要补证据：${review.reason.slice(0, 200)}`;
  } else if (review.kind === "downgrade" && review.verdict === "upheld") {
    status = "falsified";
    statusReason = `已降级/证伪：${review.reason.slice(0, 200)}`;
  }
  // 只有「成立的反驳」才加一轮；更正/撤回不加（也才不会撞上限）。
  const refuteRound = review.kind === "refute" && review.verdict === "upheld" ? rounds + 1 : rounds;
  await client.query(
    `update swarm_claim
        set status=$4,
            status_reason=$5,
            refute_rounds=$6,
            verified_version=coalesce($7, verified_version),
            verified_by=coalesce($8, verified_by),
            verified_at=case when $7 is null then verified_at else now() end
      where account_id=$1 and run_id=$2 and id=$3 and version=$9`,
    [
      account,
      runId,
      claim.id,
      status,
      statusReason,
      refuteRound,
      verifiedVersion,
      verifiedBy,
      claim.version,
    ],
  );
  // 这条结论上的全部审查 id（跨版本）：详情和页面按它列审查记录。
  const reviewIds = (
    await client.query(
      `select id from swarm_review
        where account_id=$1 and run_id=$2 and claim_id=$3 order by created_at`,
      [account, runId, claim.id],
    )
  ).rows.map((row) => String(row.id));
  const updated: Claim = {
    ...claim,
    status,
    ...(statusReason ? { statusReason } : {}),
    refuteRounds: refuteRound,
    reviews: reviewIds,
  };
  return {
    claim: updated,
    statusBefore,
    review: {
      id,
      claimId: claim.id,
      claimVersion: claim.version,
      kind: review.kind,
      by: member,
      reason: review.reason,
      evidenceIds: review.evidenceIds,
      verdict: review.verdict,
      round: input.round,
      taskId: review.taskId ?? "",
    },
  };
}

// ── 路线登记 ───────────────────────────────────────
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。、；：,.;:!?！？（）()《》“”"'’「」【】…·—\-]/g, "");

/** 中文没有空格，按字二元组算 Jaccard：够粗糙，但用来判「是不是同一件事」够用。 */
function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const grams = (value: string) => {
    const set = new Set<string>();
    for (let i = 0; i < value.length - 1; i += 1) set.add(value.slice(i, i + 2));
    if (!set.size) set.add(value);
    return set;
  };
  const ga = grams(na);
  const gb = grams(nb);
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared += 1;
  return shared / (ga.size + gb.size - shared);
}

/**
 * 是不是同一条路线（PRD §4：同义改写不能登记成新路线）。
 * 依次看：标题一模一样、标题互相包含、标题高度相似、方法族相同且做法相近、做法高度相似。
 */
export function sameRoute(
  a: { title: string; idea?: string; approachFamily?: string },
  b: { title: string; idea?: string; approachFamily?: string },
): boolean {
  const ta = normalize(a.title);
  const tb = normalize(b.title);
  if (!ta || !tb) return false;
  if (ta === tb) return true;
  // 一条是另一条的前缀/子串：负责人常把计划里的短标题展开成长标题。
  if (ta.length >= 6 && tb.length >= 6 && (ta.includes(tb) || tb.includes(ta))) return true;
  if (similarity(ta, tb) >= 0.55) return true;
  const fa = normalize(a.approachFamily ?? "");
  const fb = normalize(b.approachFamily ?? "");
  if (fa && fb && fa === fb && similarity(a.idea ?? "", b.idea ?? "") >= 0.35) return true;
  return similarity(a.idea ?? "", b.idea ?? "") >= 0.6;
}

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
  // 先按 route_id 精确找；找不到（负责人自造了 r-4 这种）再按「是不是同一件事」找。
  const wanted =
    (approach.routeId ? existing.find((route) => route.routeId === approach.routeId) : undefined) ??
    existing.find((route) => sameRoute(route, approach));
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
