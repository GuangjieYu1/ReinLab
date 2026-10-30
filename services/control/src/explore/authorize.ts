/**
 * Agent 动作的授权核对（design/prd/07-explore-contract.md 第 3 节「授权」）。
 *
 * 只认「用户本人真实说过的话」：从本档案的 user/message 事件里取原文，核对
 *   a) 这条消息属于这个账户、这份档案，且不是系统替模型加的上下文（「档案变动：」等）；
 *   b) 原文指向本批次的目标（每个受保护停留点的名称或 id）；
 *   c) 原文说的是这类动作（留下/确认、改、删、结束…）；
 *   d) 这条消息还没被用掉（一条消息只能授权一次）。
 * 只验证「消息存在、是用户说的」不够，那样模型可以拿一句无关的话当授权。
 */
import type pg from "pg";
import type { Op, Stop } from "@reinlab/contracts";
import type { StoredPlan } from "./plan";

type Client = pg.PoolClient;

/** 系统注入或审批回执，不是用户自己的要求。 */
const INJECTED_PREFIXES = ["档案变动：", "用户已批准", "用户驳回", "用户拒绝了", "继续原来的任务"];

export type AuthVerdict =
  | { ok: true; messageId: string }
  | { ok: false; reason: string };

type MessageRow = { seq: string; runId: string | null; messageId: string; text: string };

const textOf = (payload: Record<string, any>): string => {
  const blocks = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  };
  return (textOfRaw(payload) || blocks(payload.content) || blocks(payload.message?.content)).trim();
};
const textOfRaw = (payload: Record<string, any>): string =>
  typeof payload.text === "string" ? payload.text : typeof payload.message?.text === "string" ? payload.message.text : "";

function messageIdOf(payload: Record<string, any>, seq: string): string {
  for (const candidate of [
    payload.id,
    payload.messageId,
    payload.message?.id,
    payload.source?.messageId,
  ])
    if (typeof candidate === "string" && candidate !== "") return candidate;
  return "seq:" + seq;
}

async function recentUserMessages(
  client: Client,
  account: string,
  dossier: string,
): Promise<MessageRow[]> {
  const rows = (
    await client.query(
      `select seq::text seq, run_id "runId", payload
         from event
        where account_id=$1 and dossier_id=$2 and action='user/message'
        order by seq desc limit 40`,
      [account, dossier],
    )
  ).rows;
  return rows
    .filter((row) => row.payload?.source?.kind !== "runtime-context")
    .map((row) => ({
      seq: row.seq,
      runId: row.runId ?? null,
      messageId: messageIdOf(row.payload ?? {}, row.seq),
      text: textOf(row.payload ?? {}),
    }))
    .filter((row) => row.text && !INJECTED_PREFIXES.some((prefix) => row.text.startsWith(prefix)));
}

const normalize = (value: string) => value.replace(/\s+/g, "").toLowerCase();

/** 每类动作在中文里会怎么说。用户换说法就顺着走，不要求固定句式。 */
const VERBS: Record<string, string[]> = {
  confirm: ["留下", "确认", "定下", "就要", "按这个", "用它", "保留", "要这个", "定这个", "就它"],
  modify: ["改", "换", "挪", "移", "调整", "提前", "推迟", "延后", "延长", "缩短"],
  remove: ["删", "去掉", "不要", "移除", "撤掉", "拿掉", "别去", "取消这个"],
  "plan.confirm": ["确认", "就按", "按这个", "就这样", "定下来", "可以执行", "开始执行", "按计划", "都行"],
  "plan.finish": ["结束", "完成", "收工", "拍完"],
  "plan.cancel": ["取消", "不去了", "算了", "放弃"],
  "plan.set": ["改", "换", "调整", "提前", "推迟", "延期", "日期", "时间"],
};

/**
 * 某个动作在用户那句话里必须出现的目标与动作词。
 * targets 是「每个停留点一组别名」（名称或 id 任一说出来即可），
 * 一次确认多个点时每个点都要被点到。
 */
function requiredMatch(plan: StoredPlan, op: Op): { targets: string[][]; verbs: string[] } | null {
  const stopOf = (id: string): Stop | undefined => plan.document.stops.find((stop) => stop.id === id);
  switch (op.op) {
    case "stop.confirm":
      return {
        targets: op.ids.map((id) => {
          const stop = stopOf(id);
          return stop ? [stop.name, stop.id] : [id];
        }),
        verbs: VERBS.confirm,
      };
    case "stop.add":
      return { targets: [[op.stop?.name ?? ""].filter(Boolean) as string[]], verbs: VERBS.confirm };
    case "stop.update": {
      const stop = stopOf(op.id);
      return { targets: [[stop?.name ?? "", op.id].filter(Boolean)], verbs: VERBS.modify };
    }
    case "stop.remove": {
      const stop = stopOf(op.id);
      return { targets: [[stop?.name ?? "", op.id].filter(Boolean)], verbs: VERBS.remove };
    }
    case "plan.confirm":
      return { targets: [], verbs: VERBS["plan.confirm"] };
    case "plan.finish":
      return { targets: [], verbs: VERBS["plan.finish"] };
    case "plan.cancel":
      return { targets: [], verbs: VERBS["plan.cancel"] };
    // 换地点、改日期要能对上具体目标：只凭「改一下」不给放行。
    case "plan.set": {
      const groups: string[][] = [];
      const destination = op.patch?.destination;
      if (destination?.name) groups.push([destination.name]);
      if (Array.isArray(op.patch?.days) && op.patch.days.length) {
        // 用户常说的是「改到 16 号」而不是完整日期：日期词或那一天的号数都算对上。
        const days = op.patch.days;
        groups.push([...days, ...days.map((day) => String(Number(day.slice(8, 10))))].filter(Boolean));
      }
      return { targets: groups, verbs: VERBS["plan.set"] };
    }
    default:
      return null;
  }
}

/**
 * 核对一条授权。`messageId` 优先；没给就用这一轮用户自己说的最后一句
 * （模型手里没有消息 id，服务端按本轮真实用户消息判断它的本意）。
 */
export async function verifyUserAuthorization(
  client: Client,
  input: {
    account: string;
    dossier: string;
    run: string | null;
    messageId?: string;
    ops: Op[];
    plan: StoredPlan;
  },
): Promise<AuthVerdict> {
  const messages = await recentUserMessages(client, input.account, input.dossier);
  if (!messages.length) return { ok: false, reason: "还没看到你在对话里明确要求这项改动。" };

  let message: MessageRow | undefined;
  if (input.messageId) {
    message = messages.find((row) => row.messageId === input.messageId);
    if (!message) return { ok: false, reason: "这句话不是你在本档案里的原始消息，不能作为依据。" };
  } else {
    message =
      messages.find((row) => input.run && row.runId === input.run) ?? messages[0];
  }

  const used = await client.query(
    "select 1 from explore_authorization where account_id=$1 and dossier_id=$2 and message_id=$3",
    [input.account, input.dossier, message.messageId],
  );
  if (used.rowCount) return { ok: false, reason: "这句话已经用过一次授权了，这次再确认一下吧。" };

  const said = normalize(message.text);
  for (const op of input.ops) {
    const needed = requiredMatch(input.plan, op);
    if (!needed) continue;
    if (!needed.verbs.some((verb) => said.includes(normalize(verb))))
      return { ok: false, reason: "你这句话没有明确要求这项改动。" };
    for (const group of needed.targets) {
      const names = group.filter(Boolean);
      if (!names.length) continue;
      if (!names.some((target) => said.includes(normalize(target))))
        return { ok: false, reason: `你这句话没有点到「${names[0]}」。` };
    }
  }
  return { ok: true, messageId: message.messageId };
}

/** 授权用掉之后记账：同一句话不能再用第二次。 */
export async function consumeUserAuthorization(
  client: Client,
  input: { account: string; dossier: string; messageId: string; approvalId?: string | null },
) {
  await client.query(
    `insert into explore_authorization(account_id,dossier_id,message_id,approval_id)
     values($1,$2,$3,$4) on conflict (account_id,dossier_id,message_id) do nothing`,
    [input.account, input.dossier, input.messageId, input.approvalId ?? null],
  );
}
