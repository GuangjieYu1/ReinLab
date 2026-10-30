/**
 * 七台通用档案的服务层（地基第 4 项）。
 *
 * 页面接口和侧边 Agent 工具调的是同一组函数：这里只做业务动作，不区分调用方，
 * 只有 `via` 不同。每个写动作都在同一个事务里写一条 `user_op` 事件（第 8 节），
 * 并把变化推给 SSE。
 */
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { ApiFailure } from "../api/errors";

type Client = pg.PoolClient;

export type Via = "page" | "agent";

const BENCHES = [
  "curriculum",
  "research",
  "engineering",
  "creative",
  "automation",
  "data",
  "exploration",
] as const;
export type BenchId = (typeof BENCHES)[number];
const isBench = (v: unknown): v is BenchId => BENCHES.includes(v as BenchId);

/** 变化通知的订阅表：同一进程内广播（控制面是单进程）。 */
type StreamEvent = Record<string, unknown>;
const subscribers = new Map<string, Set<(event: StreamEvent) => void>>();

export function subscribe(account: string, bench: string, push: (e: StreamEvent) => void): () => void {
  const key = account + ":" + bench;
  const set = subscribers.get(key) ?? new Set();
  set.add(push);
  subscribers.set(key, set);
  return () => {
    set.delete(push);
    if (!set.size) subscribers.delete(key);
  };
}

/** 其它模块（如论文入档）改完档案后，用它把变化推给页面。 */
export async function announceDossierChanged(
  client: Client,
  account: string,
  dossier: string,
  change: string,
) {
  const row = await one(client, "select bench, version from dossier where account_id=$1 and id=$2", [
    account,
    dossier,
  ]);
  if (!row) return;
  emit(account, row.bench, { type: "dossier.changed", id: dossier, version: row.version, change });
}

/** 其它业务（探索台的计划与画布）把变化推给同一份档案的页面。 */
export function publishAccountEvent(account: string, bench: string, event: StreamEvent) {
  emit(account, bench, event);
}

function emit(account: string, bench: string, event: StreamEvent) {
  for (const push of subscribers.get(account + ":" + bench) ?? []) {
    try {
      push(event);
    } catch {
      /* 单个连接坏掉不影响别人 */
    }
  }
}

/** 操作提示里的主语：Agent 做的就是「助手把…」，用户做的就是「你把…」。 */
const who = (via: Via) => (via === "agent" ? "助手" : "你");

const title = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
const intentOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 2000) : "");

function stamp(d: Date): string {
  return d.toISOString();
}

/** 「未命名研究 · 10月30日」 */
function placeholderTitle(bench: string, at: Date): string {
  const label =
    { research: "研究", curriculum: "学习", engineering: "工程", creative: "创作", automation: "自动化", data: "数据", exploration: "探索" }[bench] ??
    "档案";
  return `未命名${label} · ${at.getMonth() + 1}月${at.getDate()}日`;
}

async function one(client: Client, sql: string, params: unknown[]) {
  const r = await client.query(sql, params as any[]);
  return r.rows[0];
}

/** 成果数量与被引用到的成果；论文、讲解层、发现卡从既有表汇总，课程/文件走 dossier_artifact。 */
async function artifactCounts(client: Client, account: string, dossier: string) {
  const row = await one(
    client,
    `select
       (select count(*) from paper_asset where account_id=$1 and dossier_id=$2)::int as papers,
       (select count(*) from event where account_id=$1 and dossier_id=$2
           and action='card_created' and payload->>'cardType'='layer')::int as layers,
       (select count(*) from event where account_id=$1 and dossier_id=$2
           and action='card_created' and payload->>'cardType'='finding')::int as findings,
       (select count(*) from event where account_id=$1 and dossier_id=$2
           and action='course_plan_created')::int as plans,
       (select count(*) from dossier_artifact where account_id=$1 and dossier_id=$2
           and removed_at is null)::int as attached`,
    [account, dossier],
  );
  const byKind: Record<string, number> = {};
  if (row.papers) byKind.paper = row.papers;
  if (row.layers) byKind.layer = row.layers;
  if (row.findings) byKind.finding = row.findings;
  if (row.plans) byKind.course_plan = row.plans;
  const attached = (
    await client.query(
      `select kind, count(*)::int n from dossier_artifact
        where account_id=$1 and dossier_id=$2 and removed_at is null group by kind`,
      [account, dossier],
    )
  ).rows;
  for (const a of attached) byKind[a.kind] = (byKind[a.kind] ?? 0) + a.n;
  const total = Object.values(byKind).reduce((a, b) => a + b, 0);
  return { total, byKind };
}

/** 一句话进展：只用真实成果拼，没有就是 null。 */
function progressOf(counts: { byKind: Record<string, number> }): string | null {
  const parts: string[] = [];
  if (counts.byKind.layer) parts.push(`已读 ${counts.byKind.layer} 层讲解`);
  if (counts.byKind.finding) parts.push(`${counts.byKind.finding} 张发现卡`);
  if (counts.byKind.paper) parts.push(`${counts.byKind.paper} 篇论文`);
  if (counts.byKind.course) parts.push(`${counts.byKind.course} 门课程`);
  if (counts.byKind.file) parts.push(`${counts.byKind.file} 个文件`);
  return parts.length ? parts.join("、") : null;
}

const RUN_ACTIVE = ["queued", "running", "waiting"];

/** 正在发生的工作（只读，不改档案生命周期）。 */
async function workOf(client: Client, account: string, dossier: string) {
  const run = await one(
    client,
    `select id,state from run where account_id=$1 and dossier_id=$2
      order by created_at desc limit 1`,
    [account, dossier],
  );
  if (!run || !["queued", "running", "waiting"].includes(run.state)) return { state: "idle" };
  if (run.state === "waiting") {
    const card = await one(
      client,
      `select id,title from approval where account_id=$1 and run_id=$2 and state='pending'
        order by created_at desc limit 1`,
      [account, run.id],
    );
    if (card)
      return { state: "waiting", runId: run.id, requestId: card.id, question: card.title ?? "" };
    return { state: "running", runId: run.id };
  }
  if (run.state === "failed") return { state: "failed", runId: run.id, reason: "上一段执行失败了，可以重试。" };
  return { state: "running", runId: run.id };
}

async function summaryOf(client: Client, account: string, row: any) {
  const counts = await artifactCounts(client, account, row.id);
  const pending = await one(
    client,
    `select count(*)::int n from approval where account_id=$1 and dossier_id=$2 and state='pending'`,
    [account, row.id],
  );
  const work = await workOf(client, account, row.id);
  return {
    id: row.id,
    bench: row.bench,
    kind: row.kind,
    title: row.title,
    nameSource: row.name_source,
    intent: row.intent,
    lifecycle: row.lifecycle,
    deletion: row.deletion,
    createdAt: stamp(row.created_at),
    updatedAt: stamp(row.updated_at ?? row.created_at),
    lastActivityAt: stamp(row.last_activity_at),
    progress: progressOf(counts),
    work,
    pending: pending?.n ?? 0,
    artifacts: counts,
    version: row.version,
  };
}

const SELECT_COLUMNS = `id,bench,kind,title,name_source,intent,lifecycle,deletion,created_at,last_activity_at,version,archived_at`;

/** 列表 / 搜索。via=user 时顺带记一条轻量搜索操作。 */
export async function listDossiers(
  client: Client,
  account: string,
  input: { bench?: string; q?: string; view?: string; via?: string; cursor?: string },
) {
  const bench = input.bench && isBench(input.bench) ? input.bench : null;
  const view = input.view === "archived" ? "archived" : "active";
  const q = (input.q ?? "").trim();
  const params: unknown[] = [account];
  let where = "account_id=$1 and deletion='none'";
  if (bench) {
    params.push(bench);
    where += ` and bench=$${params.length}`;
  }
  if (view === "archived") where += " and lifecycle='archived'";
  else where += " and lifecycle<>'archived'";
  if (q) {
    params.push("%" + q + "%");
    where += ` and (title ilike $${params.length} or coalesce(intent,'') ilike $${params.length})`;
  }
  if (input.cursor) {
    params.push(input.cursor);
    where += ` and last_activity_at < $${params.length}::timestamptz`;
  }
  params.push(51);
  const rows = (
    await client.query(
      `select ${SELECT_COLUMNS} from dossier where ${where}
        order by last_activity_at desc, id desc limit $${params.length}`,
      params as any[],
    )
  ).rows;
  const page = rows.slice(0, 50);
  const items = [];
  for (const row of page) items.push(await summaryOf(client, account, row));
  // 搜索不属于某一份档案：event.dossier_id 是必填的，所以只记在有档案在手时。
  if (input.via === "user" && page.length)
    await note(client, account, {
      dossier: page[0].id,
      actor: "user",
      via: "page",
      action: "search",
      text: bench ? `你在${benchLabel(bench)}里搜索了「${q}」` : `你搜索了「${q}」`,
    });
  return { items, nextCursor: rows.length > 50 ? stamp(page[page.length - 1].last_activity_at) : null };
}

function benchLabel(bench: string): string {
  return (
    { research: "研究台", curriculum: "学习台", engineering: "工程台", creative: "创作台", automation: "自动化台", data: "数据台", exploration: "探索台" }[bench] ??
    "工作台"
  );
}

async function loadRow(client: Client, account: string, id: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  return one(client, `select ${SELECT_COLUMNS},deleted_at from dossier where account_id=$1 and id=$2`, [
    account,
    id,
  ]);
}

/** 详情。已删除返回 410 + 墓碑，不带内容。 */
export async function getDossier(client: Client, account: string, id: string) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion === "deleted")
    throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。", {
      tombstone: { id: row.id, kind: "dossier", state: "deleted", title: row.title, at: stamp(row.deleted_at ?? row.last_activity_at) },
    });
  const summary = await summaryOf(client, account, row);
  const resume = await one(
    client,
    `select face,anchor,mode from dossier_resume where account_id=$1 and dossier_id=$2`,
    [account, id],
  );
  const runs = (
    await client.query(
      `select r.id, r.role_id as role, r.state, r.created_at, r.ended_at,
              (select e.payload->>'title' from event e
                where e.account_id=r.account_id and e.run_id=r.id and e.action='session/title'
                order by e.seq desc limit 1) as title
         from run r
        where r.account_id=$1 and r.dossier_id=$2
        order by r.created_at desc limit 20`,
      [account, id],
    )
  ).rows;
  return {
    ...summary,
    resume: resume ? { face: resume.face, ...(resume.anchor ? { anchor: resume.anchor } : {}), ...(resume.mode ? { mode: resume.mode } : {}) } : null,
    runs: runs.map((r) => ({
      id: r.id,
      role: r.role ?? "kernel",
      state: r.state,
      startedAt: stamp(r.created_at),
      endedAt: r.ended_at ? stamp(r.ended_at) : null,
      title: r.title ?? summary.title,
    })),
  };
}

/** 打开：记 open 操作、更新该台「上次打开」。不启动模型。 */
export async function openDossier(client: Client, account: string, id: string, via: Via) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion === "deleted") throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。");
  if (row.lifecycle === "archived")
    throw new ApiFailure("DOSSIER_ARCHIVED", 409, "这份档案已归档，先取消归档再打开。");
  await client.query(
    `update dossier set last_activity_at=now() where account_id=$1 and id=$2 and lifecycle='active'`,
    [account, id],
  );
  await note(client, account, {
    dossier: id,
    actor: via === "agent" ? "agent" : "user",
    via,
    action: "open",
    text: via === "agent" ? `Agent 打开了《${row.title}》` : `你打开了《${row.title}》`,
    light: true,
  });
  const detail = await getDossier(client, account, id);
  emit(account, row.bench, { type: "activity", note: activityOf(id, via, "open", `打开了《${row.title}》`) });
  return detail;
}

/** 续上次：该台上次打开的、未删除未归档的档案。 */
export async function resumeBench(client: Client, account: string, bench: string) {
  const row = await one(
    client,
    `select ${SELECT_COLUMNS} from dossier
      where account_id=$1 and bench=$2 and deletion='none' and lifecycle<>'archived'
      order by last_activity_at desc, id desc limit 1`,
    [account, bench],
  );
  return { dossier: row ? await getDossier(client, account, row.id) : null };
}

/** 记位置：不算活动、不写操作记录。 */
export async function savePosition(
  client: Client,
  account: string,
  id: string,
  point: { face?: unknown; anchor?: unknown; mode?: unknown },
) {
  const face = title(point.face);
  if (!face) throw new ApiFailure("INVALID_INPUT", 400, "需要一个工作面。");
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion !== "none") throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。");
  await client.query(
    `insert into dossier_resume(account_id,dossier_id,face,anchor,mode,updated_at)
     values($1,$2,$3,$4,$5,now())
     on conflict(account_id,dossier_id) do update
       set face=excluded.face,anchor=excluded.anchor,mode=excluded.mode,updated_at=now()`,
    [account, id, face, title(point.anchor) || null, title(point.mode) || null],
  );
}

/** 补名：这份档案已经有下载过的论文标题，就把占位名换成论文名（用户改过的不动）。 */
export async function nameFromPaper(client: Client, account: string, dossier: string) {
  const row = await one(
    client,
    `select d.name_source,
            (select coalesce(a.view_metadata->>'title','')
               from paper_asset a
              where a.account_id=d.account_id and a.dossier_id=d.id
                and coalesce(a.view_metadata->>'title','')<>''
              order by a.created_at desc limit 1) as paper_title
       from dossier d where d.account_id=$1 and d.id=$2`,
    [account, dossier],
  );
  if (!row || !["placeholder", "intent", "paper"].includes(row.name_source)) return null;
  const name = title(row.paper_title);
  if (!name) return null;
  await client.query(
    `update dossier set title=$3, name_source='paper', version=version+1,
            last_activity_at=now()
      where account_id=$1 and id=$2 and name_source<>'user'`,
    [account, dossier, name],
  );
  return name;
}

export async function createDossier(
  client: Client,
  account: string,
  input: { bench?: unknown; kind?: unknown; title?: unknown; intent?: unknown },
  via: Via,
) {
  // bench 省略时按研究台处理：老调用方只传 title，契约里的页面总会带 bench。
  const bench = isBench(input.bench) ? input.bench : input.bench === undefined ? "research" : null;
  if (!bench) throw new ApiFailure("INVALID_INPUT", 400, "需要选一个工作台。");
  const id = randomUUID();
  const now = new Date();
  const explicit = title(input.title);
  const intent = intentOf(input.intent);
  const kind = ["reading", "topic", "workspace", "learning"].includes(String(input.kind))
    ? String(input.kind)
    : bench === "research"
      ? "reading"
      : "workspace";
  const name = explicit || placeholderTitle(bench, now);
  await client.query(
    `insert into dossier(id,account_id,bench,title,workspace_path,bench_version,
        kind,intent,name_source,lifecycle,deletion,version,last_activity_at)
     values($1,$2,$3,$4,$5,'2.0.0',$6,$7,$8,'active','none',1,now())`,
    [
      id,
      account,
      bench,
      name,
      "/data/dossiers/" + id,
      kind,
      intent || null,
      explicit ? "user" : intent ? "intent" : "placeholder",
    ],
  );
  await note(client, account, {
    dossier: id,
    actor: via === "agent" ? "agent" : "user",
    via,
    action: "create",
    text: `${via === "agent" ? "Agent 建了" : "你建了"}《${name}》`,
  });
  emit(account, bench, { type: "dossier.changed", id, version: 1, change: "create" });
  return getDossier(client, account, id);
}

export async function updateDossier(
  client: Client,
  account: string,
  id: string,
  patch: { baseVersion?: unknown; title?: unknown; intent?: unknown; lifecycle?: unknown },
  via: Via,
) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion !== "none") throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。");
  if (Number(patch.baseVersion) !== row.version)
    throw new ApiFailure("VERSION_CONFLICT", 409, "别处刚改过这份档案，请用最新版本再改一次。", {
      latest: await getDossier(client, account, id),
    });
  const sets: string[] = [];
  const params: unknown[] = [account, id];
  let noteText: string | null = null;
  if (patch.title !== undefined) {
    const next = title(patch.title);
    if (!next) throw new ApiFailure("INVALID_INPUT", 400, "标题不能为空。");
    params.push(next);
    sets.push(`title=$${params.length}`, `name_source='user'`);
    noteText = `${who(via)}把《${row.title}》改名为《${next}》`;
  }
  if (patch.intent !== undefined) {
    params.push(intentOf(patch.intent) || null);
    sets.push(`intent=$${params.length}`);
    noteText = noteText ?? `${who(via)}改了《${row.title}》的目标`;
  }
  if (patch.lifecycle !== undefined) {
    const next = String(patch.lifecycle);
    if (!["active", "completed"].includes(next))
      throw new ApiFailure("INVALID_INPUT", 400, "只能标成进行中或已完成。");
    params.push(next);
    sets.push(`lifecycle=$${params.length}`);
    noteText = noteText ?? (next === "completed" ? `${who(via)}把《${row.title}》标成已完成` : `${who(via)}把《${row.title}》标回进行中`);
  }
  if (!sets.length) throw new ApiFailure("INVALID_INPUT", 400, "没有要改的内容。");
  sets.push("version=version+1", "last_activity_at=now()");
  await client.query(`update dossier set ${sets.join(",")} where account_id=$1 and id=$2`, params as any[]);
  await note(client, account, {
    dossier: id,
    actor: via === "agent" ? "agent" : "user",
    via,
    action: "rename",
    text: noteText ?? `${who(via)}改了《${row.title}》`,
  });
  const detail = await getDossier(client, account, id);
  emit(account, row.bench, { type: "dossier.changed", id, version: detail.version, change: "rename" });
  return detail;
}

/** 归档 / 取消归档。有活跃工作时返回待确认卡。 */
export async function setArchived(
  client: Client,
  account: string,
  id: string,
  archived: boolean,
  via: Via,
  origin?: string,
) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion !== "none") throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。");
  const work = await workOf(client, account, id);
  if (archived && work.state !== "idle")
    return {
      confirmation: await confirmationCard(client, account, row, "dossier.archive", via, origin),
    };
  await client.query(
    `update dossier set lifecycle=$3,
        archived_at=case when $3='archived' then now() else null end,
        version=version+1 where account_id=$1 and id=$2`,
    [account, id, archived ? "archived" : "active"],
  );
  await note(client, account, {
    dossier: id,
    actor: via === "agent" ? "agent" : "user",
    via,
    action: archived ? "archive" : "unarchive",
    text: `${via === "agent" ? "Agent " : "你"}${archived ? "归档" : "取消归档"}了《${row.title}》`,
  });
  const detail = await getDossier(client, account, id);
  emit(account, row.bench, { type: "dossier.changed", id, version: detail.version, change: archived ? "archive" : "unarchive" });
  return detail;
}

/**
 * 档案成果：关联的课程/文件走 `dossier_artifact`，入档论文走 `paper_asset`，
 * 讲解层和发现卡走既有的 `card_created` 事件。三处合起来才是契约里的 Artifact[]。
 */
export async function listArtifacts(client: Client, account: string, id: string, kind?: string) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  const wanted = typeof kind === "string" && kind.trim() !== "" ? kind.trim() : null;
  const rows = (
    await client.query(
      `select * from (
         select a.id::text "id", a.kind, a.title, a.run_id "runId", a.version, a.status, a.open,
                a.created_at "createdAt", null::text "source", null::text "doi"
           from dossier_artifact a
          where a.account_id=$1 and a.dossier_id=$2 and a.removed_at is null
         union all
         -- 入档的论文：标题用登记时的元数据，出处带来源地址或 DOI。
         select p.id::text,
                'paper',
                coalesce(nullif(p.view_metadata->>'title',''), nullif(p.paper_id,''), '这篇论文'),
                p.run_id, 1,
                case when p.status in ('full_text','abstract_only') then 'available' else 'missing' end,
                case when p.status in ('full_text','abstract_only')
                     then jsonb_build_object('to','dossier','dossierId',$2::text,
                            'resume',jsonb_build_object('face','explain','anchor','paper:'||p.id::text))
                     else jsonb_build_object('to','none','reason','这份 PDF 抽不出文本（可能是扫描件），读不到正文。')
                end,
                p.created_at, p.source, nullif(p.view_metadata->>'doi','')
           from paper_asset p
          where p.account_id=$1 and p.dossier_id=$2
         union all
         -- 讲解层/发现卡：写入时的 card_created 事件就是成果本身。
         select coalesce(e.payload->>'cardId', e.seq::text),
                e.payload->>'cardType',
                case when e.payload->>'cardType'='layer'
                     then coalesce(nullif(e.payload#>>'{card,title}',''), '讲解层')
                     else left(coalesce(nullif(e.payload#>>'{card,text}',''), '发现卡'), 120)
                end,
                e.run_id, 1, 'available',
                jsonb_build_object('to','dossier','dossierId',$2::text,
                  'resume',jsonb_build_object('face','explain',
                     'anchor',coalesce(e.payload->>'cardId', e.seq::text))),
                e.at, null, null
           from event e
          where e.account_id=$1 and e.dossier_id=$2 and e.action='card_created'
            and e.payload->>'cardType' in ('layer','finding')
       ) t
       where ($3::text is null or t.kind=$3)
       order by t."createdAt" desc`,
      [account, id, wanted] as any[],
    )
  ).rows;
  return { items: rows.map((r) => artifactOf({ ...r, dossier_id: id })) };
}

function artifactOf(row: any) {
  return {
    id: row.id,
    dossierId: row.dossier_id ?? null,
    kind: row.kind,
    title: row.title,
    runId: row.run_id ?? row.runId ?? null,
    version: row.version,
    createdAt: stamp(row.created_at ?? row.createdAt),
    status: row.status,
    open: row.open ?? { to: "none", reason: "没有可用的打开方式" },
    // 论文的出处：来源地址和 DOI，两者都可能没有（工作区登记的论文通常只有来源）。
    ...(row.kind === "paper"
      ? { provenance: { source: row.source ?? null, doi: row.doi ?? null } }
      : {}),
  };
}

export async function attachCourse(
  client: Client,
  account: string,
  id: string,
  courseId: string,
  courseTitle: string,
) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  const existing = await one(
    client,
    `select id,kind,title,run_id,version,status,open,created_at from dossier_artifact
      where account_id=$1 and dossier_id=$2 and kind='course' and open->>'courseId'=$3 and removed_at is null`,
    [account, id, courseId],
  );
  if (existing) return artifactOf(existing);
  const created = await one(
    client,
    `insert into dossier_artifact(id,account_id,dossier_id,kind,title,status,open)
     values($1,$2,$3,'course',$4,'available',$5)
     returning id,kind,title,run_id,version,status,open,created_at`,
    [randomUUID(), account, id, courseTitle, JSON.stringify({ to: "course", courseId })],
  );
  await client.query(
    "update dossier set last_activity_at=now(), version=version+1 where account_id=$1 and id=$2",
    [account, id],
  );
  await note(client, account, {
    dossier: id,
    actor: "user",
    via: "page",
    action: "attach",
    text: `${who("page")}把课程《${courseTitle}》加进了《${row.title}》`,
  });
  emit(account, row.bench, { type: "dossier.changed", id, version: row.version + 1, change: "artifacts" });
  return artifactOf(created);
}

export async function detachArtifact(client: Client, account: string, id: string, artifactId: string) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  const found = await one(
    client,
    `update dossier_artifact set removed_at=now()
      where account_id=$1 and dossier_id=$2 and id=$3 and removed_at is null
      returning kind,title`,
    [account, id, artifactId],
  );
  if (!found) throw new ApiFailure("ARTIFACT_REMOVED", 410, "这项成果已从档案移除。");
  await client.query(
    "update dossier set last_activity_at=now(), version=version+1 where account_id=$1 and id=$2",
    [account, id],
  );
  await note(client, account, {
    dossier: id,
    actor: "user",
    via: "page",
    action: "detach",
    text: `${who("page")}从《${row.title}》移除了材料《${found.title}》，该材料已不可读取`,
  });
  emit(account, row.bench, { type: "dossier.changed", id, version: row.version + 1, change: "artifacts" });
}

/** 活动提示：只读 `user_op` 事件，页面用来在 Agent 坞显示一行灰字。 */
export async function listActivity(client: Client, account: string, id: string, after?: string) {
  const params: unknown[] = [account, id];
  let where = "account_id=$1 and dossier_id=$2 and kind='user_op'";
  if (after) {
    params.push(Number(after) || 0);
    where += ` and seq > $${params.length}`;
  }
  const rows = (
    await client.query(
      `select seq,at,payload from event where ${where} order by seq limit 100`,
      params as any[],
    )
  ).rows;
  return {
    items: rows.map((r) => r.payload),
    cursor: rows.length ? String(rows[rows.length - 1].seq) : after ?? "0",
  };
}

function activityOf(dossier: string, via: Via, action: string, text: string) {
  return {
    id: randomUUID(),
    at: new Date().toISOString(),
    dossierId: dossier,
    actor: via === "agent" ? "agent" : "user",
    via,
    action,
    text: text,
  };
}

/** 第 8 节：业务动作里同事务写一条 user_op，并把同一行推给页面。 */
async function note(
  client: Client,
  account: string,
  input: {
    dossier: string | null;
    actor: "user" | "agent" | "system";
    via: Via;
    action: string;
    text: string;
    light?: boolean;
    before?: unknown;
    after?: unknown;
  },
) {
  const id = randomUUID();
  const payload = {
    id,
    at: new Date().toISOString(),
    dossierId: input.dossier,
    actor: input.actor,
    via: input.via,
    action: input.action,
    text: input.text,
  };
  await client.query(
    `insert into event(account_id,dossier_id,kind,action,payload,dedupe_key)
     values($1,$2,'user_op',$3,$4,$5) on conflict do nothing`,
    [account, input.dossier, input.action, JSON.stringify(payload), "user_op:" + id],
  );
  return payload;
}

/** 删除确认卡：复用 approval，一张待确认卡只能有一张。 */
async function confirmationCard(
  client: Client,
  account: string,
  row: any,
  kind: string,
  via: Via,
  originDossier?: string,
) {
  const impact = await deleteImpact(client, account, row.id);
  const existing = await one(
    client,
    `select id,state,effects from approval
      where account_id=$1 and dossier_id=$2 and state='pending' and effects->>'kind'=$3
      order by created_at desc limit 1`,
    [account, row.id, kind],
  );
  if (existing)
    return confirmationOf(existing.id, kind, row, impact, existing.state);
  const created = await one(
    client,
    `insert into approval(account_id,dossier_id,kind,title,effects,risk,state)
     values($1,$2,'permission',$3,$4,'danger','pending')
     returning id,state`,
    [
      account,
      row.id,
      kind === "dossier.delete" ? `确认删除《${row.title}》` : `确认归档《${row.title}》`,
      JSON.stringify({
        kind,
        target: { id: row.id, title: row.title, bench: row.bench },
        impact,
        via,
        ...(originDossier ? { origin: { dossier: originDossier } } : {}),
      }),
    ],
  );
  const card = confirmationOf(created.id, kind, row, impact, "pending");
  emit(account, row.bench, { type: "confirmation.created", confirmation: card });
  return card;
}

function confirmationOf(id: string, kind: string, row: any, impact: any, state: string) {
  return {
    id,
    kind,
    target: { id: row.id, title: row.title, bench: row.bench },
    impact,
    state,
  };
}

async function deleteImpact(client: Client, account: string, id: string) {
  const active = await one(
    client,
    `select count(*)::int n from run where account_id=$1 and dossier_id=$2
        and state in ('queued','running','waiting')`,
    [account, id],
  );
  const pending = await one(
    client,
    `select count(*)::int n from approval where account_id=$1 and dossier_id=$2 and state='pending'`,
    [account, id],
  );
  const counts = await artifactCounts(client, account, id);
  return {
    activeRuns: active?.n ?? 0,
    pendingRequests: pending?.n ?? 0,
    artifacts: counts.total,
    note: "删除后列表、搜索和续上次都看不到这份档案；原始文件和外部课程不会被删除。不是永久擦除。",
  };
}

export async function requestDelete(
  client: Client,
  account: string,
  id: string,
  via: Via,
  origin?: string,
) {
  const row = await loadRow(client, account, id);
  if (!row) throw new ApiFailure("DOSSIER_NOT_FOUND", 404, "找不到这份档案。");
  if (row.deletion !== "none") throw new ApiFailure("DOSSIER_DELETED", 410, "这份档案已删除。");
  return { confirmation: await confirmationCard(client, account, row, "dossier.delete", via, origin) };
}

/** 确认批准后真正执行：先 stop，再标记 deleted（复用第 2 项的取消流程）。 */
export async function applyConfirmation(
  client: Client,
  account: string,
  approvalId: string,
  approved: boolean,
) {
  const card = await one(
    client,
    `select id,dossier_id,state,effects from approval where account_id=$1 and id=$2`,
    [account, approvalId],
  );
  if (!card) return null;
  const effects = card.effects ?? {};
  if (!effects.kind?.startsWith?.("dossier.")) return null;
  const via: Via = effects.via === "agent" ? "agent" : "page";
  const originDossier: string | undefined = effects.origin?.dossier;
  const row = await loadRow(client, account, card.dossier_id);
  if (!row) return null;
  if (!approved) {
    emit(account, row.bench, {
      type: "confirmation.decided",
      confirmation: confirmationOf(card.id, effects.kind, row, effects.impact ?? (await deleteImpact(client, account, row.id)), "rejected"),
    });
    return null;
  }
  if (effects.kind === "dossier.delete") {
    await client.query(
      "update dossier set deletion='stopping', version=version+1 where account_id=$1 and id=$2",
      [account, row.id],
    );
    // 复用第 2 项：取消仍在跑的运行、关掉待处理请求。
    await client.query(
      `update approval set state='expired'
        where account_id=$1 and dossier_id=$2 and state='pending'`,
      [account, row.id],
    );
    await client.query(
      `update run set state='cancelled', ended_at=coalesce(ended_at,now())
        where account_id=$1 and dossier_id=$2 and state in ('queued','running','waiting')`,
      [account, row.id],
    );
    await client.query(
      `update dossier set deletion='deleted', deleted_at=now(), version=version+1
        where account_id=$1 and id=$2`,
      [account, row.id],
    );
    await note(client, account, {
      dossier: row.id,
      actor: "user",
      via: "page",
      action: "delete",
      text: `${who(via)}删除了《${row.title}》`,
    });
    // 发起删除的那段对话要如实知道结果，否则它下一轮还会说「还在等你确认」。
    if (originDossier && originDossier !== row.id)
      await note(client, account, {
        dossier: originDossier,
        actor: "system",
        via,
        action: "delete",
        text: `《${row.title}》已删除，不再出现在列表和搜索里`,
      });
    emit(account, row.bench, {
      type: "dossier.deleted",
      id: row.id,
      tombstone: { id: row.id, kind: "dossier", state: "deleted", title: row.title, at: new Date().toISOString() },
    });
  } else {
    await client.query(
      `update dossier set lifecycle='archived', archived_at=now(), version=version+1
        where account_id=$1 and id=$2`,
      [account, row.id],
    );
    await note(client, account, {
      dossier: row.id,
      actor: "user",
      via: "page",
      action: "archive",
      text: `${who(via)}归档了《${row.title}》`,
    });
    if (originDossier && originDossier !== row.id)
      await note(client, account, {
        dossier: originDossier,
        actor: "system",
        via,
        action: "archive",
        text: `《${row.title}》已归档`,
      });
    emit(account, row.bench, { type: "dossier.changed", id: row.id, version: row.version + 1, change: "archive" });
  }
  return { kind: effects.kind, dossierId: row.id };
}

/** 一次性补名：把历史「新的精读」在能确定论文时补成论文名。 */
export async function backfillReadingNames(client: Client, account: string) {
  const rows = (
    await client.query(
      `select d.id from dossier d
        where d.account_id=$1 and d.bench='research' and d.name_source<>'user'
          and (d.title like '新的精读%' or d.title like '未命名研究%')`,
      [account],
    )
  ).rows;
  let renamed = 0;
  for (const r of rows) if (await nameFromPaper(client, account, r.id)) renamed++;
  return renamed;
}
