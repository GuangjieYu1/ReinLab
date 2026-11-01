/**
 * 现场记录（design/prd/09-explore-v2.md §3.3、10-explore-v2-contract.md §1–2.2）。
 *
 * 现场记录是附加事实，不参与计划修订：离线新增的记录按设备 clientId 幂等入库，
 * 重复上传只存一份；撤销/改字/重新关联一律是新的 correction 记录指回原记录，
 * 不改原行，这样已上传的事件和本地编辑不会互相覆盖。
 *
 * 停留点被删后记录照样保留（原名称还在），状态标 orphan 等用户重新关联；
 * 服务端绝不因为旧快照去恢复停留点。
 */
import type pg from "pg";
import type { FieldEventRecord, LngLat } from "@reinlab/contracts";
import { canonical } from "../api/context";
/** 只用到「当前计划里有哪些停留点」；修订快照也能直接喂进来。 */
type StopsOf = { stops: { id: string }[] };

type Client = pg.PoolClient;

type Correction =
  | { action: "retract" }
  | { action: "edit"; text: string }
  | { action: "relink"; stopId: string };

export type FieldEventInput = {
  clientId: string;
  kind: "arrived" | "shot" | "note" | "situation" | "correction";
  stopId: string | null;
  stopName: string | null;
  planRevision: number;
  at: string;
  tz: string;
  text?: string;
  situation?: "rain" | "late" | "crowd" | "light" | "other";
  position?: { at: LngLat; accuracyM: number };
  refersTo?: string;
  correction?: Correction;
};

export type FieldResultStatus = "ok" | "orphan" | "duplicate" | "conflict";

export type FieldResult = {
  clientId: string;
  serverId: string;
  status: FieldResultStatus;
  /** duplicate / conflict 时给出服务端那一份，页面据此二选一。 */
  server?: FieldEventRecord;
  /** 给人看的一句：为什么是 orphan / conflict。 */
  note?: string;
};

type Row = {
  server_id: string;
  client_id: string;
  kind: FieldEventInput["kind"];
  stop_id: string | null;
  stop_name: string | null;
  plan_revision: number;
  at: Date;
  tz: string;
  text: string | null;
  situation: FieldEventInput["situation"] | null;
  position: { at: LngLat; accuracyM: number } | null;
  refers_to: string | null;
  correction: Correction | null;
  received_at: Date;
};

const COLUMNS =
  "server_id,client_id,kind,stop_id,stop_name,plan_revision,at,tz,text,situation,position,refers_to,correction,received_at";

/** 现场时间按记录时的时区写回带偏移的 ISO：页面显示的就是拍摄现场那一刻。 */
export function formatInZone(value: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const offset =
    new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(value)
      .find((part) => part.type === "timeZoneName")
      ?.value.replace("GMT", "") || "+00:00";
  const millis = value.getUTCMilliseconds();
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${
    millis ? `.${String(millis).padStart(3, "0")}` : ""
  }${offset}`;
}

const recordOf = (
  row: Row,
  status: FieldEventRecord["status"],
  effective: { text?: string | null; stopId?: string | null },
): FieldEventRecord => ({
  clientId: row.client_id,
  kind: row.kind,
  stopId: effective.stopId !== undefined ? effective.stopId : row.stop_id,
  stopName: row.stop_name,
  planRevision: Number(row.plan_revision),
  at: formatInZone(new Date(row.at), row.tz),
  tz: row.tz,
  ...(row.text !== null ? { text: row.text } : {}),
  ...(row.situation ? { situation: row.situation } : {}),
  ...(row.position ? { position: row.position } : {}),
  ...(row.refers_to ? { refersTo: row.refers_to } : {}),
  ...(row.correction ? { correction: row.correction } : {}),
  serverId: row.server_id,
  receivedAt: new Date(row.received_at).toISOString(),
  status,
  ...(effective.text !== undefined && effective.text !== null
    ? { effectiveText: effective.text }
    : {}),
});

/** 同一条 clientId 重发时，内容是否一模一样（不一样就是冲突，不覆盖服务端）。 */
function sameEvent(row: Row, input: FieldEventInput): boolean {
  return (
    canonical({
      kind: row.kind,
      stopId: row.stop_id,
      stopName: row.stop_name,
      planRevision: Number(row.plan_revision),
      // 时间按时刻比，不按字符串比：同一刻写成 Z 或 +08:00 都算同一条。
      at: Math.floor(new Date(row.at).getTime() / 1000),
      tz: row.tz,
      text: row.text ?? null,
      situation: row.situation ?? null,
      position: row.position ?? null,
      refersTo: row.refers_to ?? null,
      correction: row.correction ?? null,
    }) ===
    canonical({
      kind: input.kind,
      stopId: input.stopId,
      stopName: input.stopName,
      planRevision: input.planRevision,
      at: Math.floor(new Date(input.at).getTime() / 1000),
      tz: input.tz,
      text: input.text ?? null,
      situation: input.situation ?? null,
      position: input.position ?? null,
      refersTo: input.refersTo ?? null,
      correction: input.correction ?? null,
    })
  );
}

const stopKnown = (document: StopsOf, stopId: string | null) =>
  !stopId || document.stops.some((stop) => stop.id === stopId);

/**
 * 批量入库。返回每条的结果：新存 → ok（或 orphan），同一条重发 → duplicate，
 * 同一条但内容不同 → conflict（附服务端版本，页面让用户二选一）。
 */
export async function appendFieldEvents(
  client: Client,
  input: { account: string; dossier: string; document: StopsOf; events: FieldEventInput[] },
): Promise<{ results: FieldResult[]; inserted: number }> {
  const { account, dossier, document, events } = input;
  const results: FieldResult[] = [];
  let inserted = 0;
  for (const event of events) {
    const row = (
      await client.query(
        `insert into explore_field_event
           (account_id,dossier_id,client_id,kind,stop_id,stop_name,plan_revision,at,tz,text,situation,position,refers_to,correction)
         values($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12::jsonb,$13,$14::jsonb)
         on conflict (account_id,dossier_id,client_id) do nothing
         returning ${COLUMNS}`,
        [
          account,
          dossier,
          event.clientId,
          event.kind,
          event.stopId,
          event.stopName,
          event.planRevision,
          event.at,
          event.tz,
          event.text ?? null,
          event.situation ?? null,
          event.position ? JSON.stringify(event.position) : null,
          event.refersTo ?? null,
          event.correction ? JSON.stringify(event.correction) : null,
        ],
      )
    ).rows[0] as Row | undefined;

    if (row) {
      inserted += 1;
      const stopId = event.kind === "correction" ? null : event.stopId;
      const orphan = !stopKnown(document, stopId);
      results.push({
        clientId: event.clientId,
        serverId: row.server_id,
        status: orphan ? "orphan" : "ok",
        ...(orphan ? { note: "这个停留点已经不在当前计划里了；记录留着，可重新关联。" } : {}),
      });
      continue;
    }

    const existing = (
      await client.query(
        `select ${COLUMNS} from explore_field_event
          where account_id=$1 and dossier_id=$2 and client_id=$3`,
        [account, dossier, event.clientId],
      )
    ).rows[0] as Row;
    const server = recordOf(existing, "ok", {});
    results.push(
      sameEvent(existing, event)
        ? { clientId: event.clientId, serverId: existing.server_id, status: "duplicate", server }
        : {
            clientId: event.clientId,
            serverId: existing.server_id,
            status: "conflict",
            server,
            note: "同一条记录在服务端已有不同内容，没有覆盖；请选保留哪一份。",
          },
    );
  }
  return { results, inserted };
}

/**
 * 读现场记录：更正叠到原记录上给出有效内容与状态。
 *
 * 更正本身不单独列出（它就是「对原记录的那次改动」）；指不到记录的更正会列出来
 * 并标 orphan，别让它在同步里凭空消失。更正也可以被撤销：指向某条更正的 retract
 * 让那次更正失效。
 */
export async function listFieldEvents(
  client: Client,
  input: { account: string; dossier: string; document: StopsOf },
): Promise<FieldEventRecord[]> {
  const rows = (
    await client.query(
      `select ${COLUMNS} from explore_field_event
        where account_id=$1 and dossier_id=$2
        order by at asc, received_at asc`,
      [input.account, input.dossier],
    )
  ).rows as Row[];

  const byClient = new Map(rows.map((row) => [row.client_id, row]));
  const corrections = rows.filter((row) => row.kind === "correction");
  const retractedCorrections = new Set(
    corrections
      .filter((row) => row.correction?.action === "retract" && row.refers_to)
      .map((row) => String(row.refers_to)),
  );
  const folded = new Map<string, { text?: string | null; stopId?: string | null; retracted?: boolean }>();
  const dangling: Row[] = [];

  for (const correction of corrections) {
    const target = correction.refers_to ? byClient.get(correction.refers_to) : undefined;
    if (!target) {
      dangling.push(correction);
      continue;
    }
    // 这条更正自己被撤销了：它对原记录不再起作用。
    if (retractedCorrections.has(correction.client_id)) continue;
    const action = correction.correction;
    if (!action) continue;
    const state = folded.get(target.client_id) ?? {};
    if (action.action === "retract") state.retracted = true;
    else if (action.action === "edit") state.text = action.text;
    else if (action.action === "relink") state.stopId = action.stopId;
    folded.set(target.client_id, state);
  }

  const items: FieldEventRecord[] = [];
  for (const row of rows) {
    if (row.kind === "correction") continue;
    const state = folded.get(row.client_id) ?? {};
    const stopId = state.stopId !== undefined ? state.stopId : row.stop_id;
    const status: FieldEventRecord["status"] = state.retracted
      ? "retracted"
      : stopKnown(input.document, stopId)
        ? "ok"
        : "orphan";
    items.push(
      recordOf(row, status, { text: state.text !== undefined ? state.text : row.text, stopId }),
    );
  }
  for (const row of dangling) items.push(recordOf(row, "orphan", {}));
  return items;
}
