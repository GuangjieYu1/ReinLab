/**
 * 计划修订快照（design/prd/09-explore-v2.md §3.3、10-explore-v2-contract.md §2.2）。
 *
 * 每次生效的业务批次留一份正文：出发时用的那一版要留得下来，离线包按固定修订
 * 生成清单，回顾时「计划 vs 实际」才有依据。历史修订不随当前计划被改写。
 */
import type pg from "pg";
import type { ExplorePlan } from "@reinlab/contracts";
import { ApiFailure } from "../api/errors";
import { documentOf, planOf, type PlanDocument } from "./plan";
import { listRefs, type ExploreStorage } from "./refs";

type Client = pg.PoolClient;

/** 留一份修订正文；已存在就不动（同一修订只可能是同一份内容）。 */
export async function snapshotRevision(
  client: Client,
  input: { account: string; dossier: string; revision: number; state: ExplorePlan["state"]; document: PlanDocument },
): Promise<void> {
  if (!(input.revision > 0)) return;
  await client.query(
    `insert into explore_plan_revision(account_id,dossier_id,revision,state,document)
     values($1,$2,$3,$4,$5::jsonb)
     on conflict (account_id,dossier_id,revision) do nothing`,
    [input.account, input.dossier, input.revision, input.state, JSON.stringify(input.document)],
  );
}

/** 和 GET /v1/explore/plans/:id 同一个形状：快照直接当「那一版」用。 */
export type RevisionSnapshot = {
  plan: ExplorePlan;
  canvas: PlanDocument["canvas"];
  refs: Awaited<ReturnType<typeof listRefs>>;
  lastViewport: PlanDocument["lastViewport"];
  basemap: PlanDocument["basemap"];
};

/**
 * 某一修订的计划快照。
 *
 * 修改/确认之前的那一版（修订 1）如果没有业务批次写过快照，就按当前正文回填：
 * 没有发生写操作时，当前正文就是那一版；真有后来的修改，历史快照由批次自己留着。
 */
export async function readRevision(
  client: Client,
  account: string,
  dossier: string,
  revision: number,
): Promise<RevisionSnapshot> {
  if (!Number.isInteger(revision) || revision <= 0)
    throw new ApiFailure("REVISION_NOT_FOUND", 404, "修订号要从 1 开始。");
  const row = (
    await client.query(
      `select revision,state,document,created_at from explore_plan_revision
        where account_id=$1 and dossier_id=$2 and revision=$3`,
      [account, dossier, revision],
    )
  ).rows[0];
  if (!row) throw new ApiFailure("REVISION_NOT_FOUND", 404, "服务器上没有留下这一版计划的快照。");
  const document = documentOf(row.document);
  const updatedAt = new Date(row.created_at).toISOString();
  return {
    plan: planOf(dossier, {
      revision: Number(row.revision),
      state: row.state as ExplorePlan["state"],
      document,
      updatedAt,
    }),
    canvas: document.canvas,
    // 参考图不按修订存：这里给的是现在档案里的图，够回顾对照用。
    refs: await listRefs(client, account, dossier),
    lastViewport: document.lastViewport,
    basemap: document.basemap,
  };
}
