import type pg from "pg";
import type {
  BusEntry,
  MemberLogItem,
  MemberRole,
  SwarmMember,
  SwarmTask,
  SwarmTaskState,
} from "@reinlab/contracts";

/**
 * 把 DSH 会话事件折算成研究事件（13-swarm-contract.md §3、12-swarm.md §7）。
 *
 * 为什么这么做：DSH 任务板是执行任务的唯一真源，研究语义（路线、轮次、计划版本）
 * 是 ReinLab 自己的。控制面不去抢任务状态，只把负责人的会话日志里已经发生的
 * 家庭成员、任务变化、消息收发折算成页面要的统一事件流；折算按 DSH 事件 seq 幂等，
 * 重放和重启都不会把同一件事算两遍。
 *
 * 拿不到的：队员自己会话里的工具调用和它发出去的消息（DSH 只把团队成员与任务
 * 变化追加到负责人会话）。这些条目 delivery 如实标 unknown，不假装已送达。
 */

export type DshRow = { seq: number | string; action: string; payload: unknown };

export type FoldContext = {
  account: string;
  runId: string;
  dossierId: string;
  planVersion: number;
  round: number;
  model: string;
};

type Call = { callId: string; name: string; args: Record<string, unknown>; busSeq?: number };

export type FoldState = {
  members: Map<string, SwarmMember>;
  tasks: Map<string, SwarmTask>;
  calls: Map<string, Call>;
};

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** 队员名 → 角色。名字由负责人的编制约定给出，认不出就当研究员。 */
export function roleOf(name: string): MemberRole {
  if (name === "lead") return "lead";
  if (/critic|refut|review|反驳/i.test(name)) return "critic";
  if (/verif|check|核实/i.test(name)) return "verifier";
  return "researcher";
}

const ROLE_LABEL: Record<MemberRole, string> = {
  lead: "负责人",
  researcher: "研究员",
  critic: "反驳",
  verifier: "核实",
};

/** 显示名：`研究员 01`。序号沿用成员名里的数字，没有就不带。 */
export function labelOf(name: string): string {
  if (name === "lead") return ROLE_LABEL.lead;
  const role = roleOf(name);
  if (role === "lead") return ROLE_LABEL.lead;
  const number = /(\d+)\s*$/.exec(name)?.[1];
  return number ? `${ROLE_LABEL[role]} ${number.padStart(2, "0")}` : ROLE_LABEL[role];
}

/**
 * 任务描述开头可以带一行结构化提示（ReinLab 的研究任务约定）：
 * `route=r1 kind=research parent=task-3 contract=2`。
 * 解析不出来就走默认：研究员任务、无路线、挂在根下。
 */
export function taskHints(description: string): {
  routeId: string | null;
  kind: SwarmTask["kind"];
  parentId: string | null;
  contractVersion: number | null;
} {
  const head = description.trim().split(/\r?\n/, 1)[0] ?? "";
  const read = (key: string) => new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(head)?.[1] ?? null;
  const kindRaw = read("kind");
  const kinds = new Set<SwarmTask["kind"]>([
    "root",
    "route",
    "research",
    "review",
    "verify",
    "synthesis",
    "other",
  ]);
  const contract = Number(read("contract"));
  return {
    routeId: read("route"),
    kind: kindRaw && kinds.has(kindRaw as SwarmTask["kind"]) ? (kindRaw as SwarmTask["kind"]) : "research",
    parentId: read("parent"),
    contractVersion: Number.isSafeInteger(contract) && contract > 0 ? contract : null,
  };
}

/** DSH 原生状态 + 依赖完成情况 → 服务端合成的研究状态。 */
export function taskState(board: SwarmTask["board"], blocked: boolean): SwarmTaskState {
  if (board === "completed") return "delivered";
  if (board === "in_progress") return "doing";
  return blocked ? "blocked" : "open";
}

/**
 * 读回已经折算过的状态：每个成员/任务只取最后一条。
 * 这样一批新事件可以接着上一批往下推，而不是从头重算整条时间线。
 */
export async function loadFold(
  client: pg.PoolClient,
  account: string,
  runId: string,
): Promise<FoldState> {
  const members = await client.query(
    `select distinct on (data->>'id') data from swarm_event
      where account_id=$1 and run_id=$2 and type='member'
      order by data->>'id', seq desc`,
    [account, runId],
  );
  const tasks = await client.query(
    `select distinct on (data->>'id') data from swarm_event
      where account_id=$1 and run_id=$2 and type='task'
      order by data->>'id', seq desc`,
    [account, runId],
  );
  const calls = await client.query(
    `select call_id,name,bus_seq from swarm_call where account_id=$1 and run_id=$2`,
    [account, runId],
  );
  return {
    members: new Map(members.rows.map((row) => [String(row.data.id), row.data as SwarmMember])),
    tasks: new Map(tasks.rows.map((row) => [String(row.data.id), row.data as SwarmTask])),
    calls: new Map(
      calls.rows.map((row) => [
        String(row.call_id),
        { callId: String(row.call_id), name: String(row.name), args: {}, ...(row.bus_seq ? { busSeq: Number(row.bus_seq) } : {}) },
      ]),
    ),
  };
}

export type Emitted = { seq: number; type: string; data: unknown };

/** 追加一条研究事件；source_seq 相同就什么都不做（幂等）。 */
export async function emit(
  client: pg.PoolClient,
  context: FoldContext,
  type: string,
  data: unknown,
  options: { source?: "dsh" | "control" | "user" | "system"; sourceSeq?: number; at?: Date } = {},
): Promise<number | null> {
  const result = await client.query(
    `insert into swarm_event(account_id,run_id,dossier_id,type,data,source,source_seq,at)
     values($1,$2,$3,$4,$5,$6,$7,coalesce($8, now()))
     returning seq`,
    [
      context.account,
      context.runId,
      context.dossierId,
      type,
      JSON.stringify(data),
      options.source ?? "control",
      options.sourceSeq ?? null,
      options.at ?? null,
    ],
  );
  return result.rows[0] ? Number(result.rows[0].seq) : null;
}

/** 发送结果写回同一条目（delivery 是活状态，不新增第二行）。 */
async function setDelivery(
  client: pg.PoolClient,
  context: FoldContext,
  busSeq: number,
  delivery: BusEntry["delivery"],
  extra: Partial<BusEntry> = {},
) {
  const current = await client.query(
    `select data from swarm_event where account_id=$1 and run_id=$2 and seq=$3`,
    [context.account, context.runId, busSeq],
  );
  if (!current.rows[0]) return;
  const data = { ...(current.rows[0].data as BusEntry), ...extra, delivery };
  await client.query(
    `update swarm_event set data=$4 where account_id=$1 and run_id=$2 and seq=$3`,
    [context.account, context.runId, busSeq, JSON.stringify(data)],
  );
}

const parseJson = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "string") return obj(value);
  try {
    return obj(JSON.parse(value));
  } catch {
    return {};
  }
};

/** 工具结果里那段 JSON（DSH 把工具返回放在 message.content[].text）。 */
function resultValue(payload: Record<string, unknown>): Record<string, unknown> {
  const message = obj(payload.message);
  const first = arr(message.content)[0];
  const text = str(obj(first).text);
  if (text) return parseJson(text);
  return {};
}

type FoldDeps = {
  /** 每个成员的会话记录条目（插件上报的可见工作记录）。 */
  memberLog?: (context: FoldContext, payload: Record<string, unknown>) => Promise<void>;
};

/**
 * 折算一批 DSH 事件。返回这次真正写进去的新事件（stream 用）。
 *
 * 顺序就是会话里的真实顺序；不按时间戳排，也不跨会话比较时钟。
 */
export async function projectEvents(
  client: pg.PoolClient,
  context: FoldContext,
  rows: DshRow[],
  state: FoldState,
  deps: FoldDeps = {},
): Promise<Emitted[]> {
  const out: Emitted[] = [];
  const push = async (
    type: string,
    data: unknown,
    sourceSeq: number,
  ) => {
    let seq = await emit(client, context, type, data, { source: "dsh", sourceSeq });
    if (seq === null) return seq;
    // 通信条目和队员记录的 seq 是「全局事件序号」：插进去才知道是几号，
    // 补进 data 里，实时流和分页时间线拿到的才是同一个 seq（页面按它去重排序）。
    if (type === "bus" || type === "member_log") {
      const withSeq = { ...(data as Record<string, unknown>), seq };
      await client.query(
        "update swarm_event set data=$3 where account_id=$1 and run_id=$2 and seq=$4",
        [context.account, context.runId, JSON.stringify(withSeq), seq],
      );
      out.push({ seq, type, data: withSeq });
      return seq;
    }
    out.push({ seq, type, data });
    return seq;
  };

  /** 负责人是隐式的（DSH 没有它的成员事件）：名册第一行按 teamId=负责人会话补上。 */
  const ensureLead = async (teamId: string, sourceSeq: number) => {
    if (!teamId || state.members.has("lead")) return;
    const lead: SwarmMember = {
      id: "lead",
      role: "lead",
      label: labelOf("lead"),
      tags: [],
      model: context.model,
      context: "fresh",
      state: "running",
      sessionId: teamId,
    };
    state.members.set("lead", lead);
    await push("member", lead, sourceSeq);
  };

  for (const row of rows) {
    const sourceSeq = Number(row.seq);
    const payload = obj(row.payload);
    switch (row.action) {
      case "team/member": {
        await ensureLead(str(payload.teamId) ?? "", sourceSeq);
        const member = obj(payload.member);
        const name = str(member.name);
        if (!name) break;
        const phase = str(member.phase);
        const prior = state.members.get(name);
        const next: SwarmMember = {
          id: name,
          role: roleOf(name),
          label: labelOf(name),
          tags: prior?.tags ?? [],
          model: prior?.model ?? context.model,
          context: member.context === "fork" ? "inherited" : "fresh",
          state:
            phase === "failed"
              ? "failed"
              : phase === "provisioning"
                ? "creating"
                : prior && prior.state !== "creating"
                  ? prior.state
                  : "idle",
          ...(prior?.doing ? { doing: prior.doing } : {}),
          sessionId: String(member.id ?? prior?.sessionId ?? ""),
          ...(str(member.error) ? { failReason: str(member.error)! } : {}),
        };
        state.members.set(name, next);
        await push("member", next, sourceSeq);
        break;
      }
      case "team/task": {
        await ensureLead(str(payload.teamId) ?? "", sourceSeq);
        const task = obj(payload.task);
        const id = str(task.id);
        if (!id) break;
        if (task.status === "deleted") {
          state.tasks.delete(id);
          break;
        }
        const prior = state.tasks.get(id);
        const description = String(task.description ?? "");
        const hints = taskHints(description);
        const board = (str(task.status) ?? "pending") as SwarmTask["board"];
        const dependsOn = arr(task.blockedBy).map(String);
        const blockedBy = dependsOn.filter((dep) => state.tasks.get(dep)?.board !== "completed");
        const ownerId = str(task.ownerId);
        // 任务板里存的是成员会话 id；研究侧和页面按成员名认人。
        const ownerName = ownerId
          ? ([...state.members.values()].find((member) => member.sessionId === ownerId)?.id ??
            prior?.owner ??
            ownerId)
          : null;
        const next: SwarmTask = {
          id,
          revision: Number(task.revision ?? 1),
          parentId: hints.parentId ?? prior?.parentId ?? null,
          kind: hints.kind !== "research" || !prior ? hints.kind : prior.kind,
          title: String(task.subject ?? prior?.title ?? ""),
          routeId: hints.routeId ?? prior?.routeId ?? null,
          round: prior?.round ?? context.round,
          planVersion: prior?.planVersion ?? context.planVersion,
          contractVersion: hints.contractVersion ?? prior?.contractVersion ?? null,
          owner: ownerName,
          board,
          state: taskState(board, blockedBy.length > 0),
          dependsOn,
          ...(blockedBy.length
            ? { blockedBy: { taskIds: blockedBy, reason: "依赖的任务还没完成" } }
            : {}),
          submissions: prior?.submissions ?? [],
          updatedAt: new Date().toISOString(),
        };
        state.tasks.set(id, next);
        await push("task", next, sourceSeq);
        // 依赖变化会改别的任务能不能开工：一起推一遍新的状态。
        for (const [otherId, other] of state.tasks) {
          if (otherId === id || !other.dependsOn.includes(id)) continue;
          const ready = other.dependsOn.filter((dep) => state.tasks.get(dep)?.board !== "completed");
          const settled: SwarmTask = {
            ...other,
            state: taskState(other.board, ready.length > 0),
            ...(ready.length ? { blockedBy: { taskIds: ready, reason: "依赖的任务还没完成" } } : { blockedBy: null }),
          };
          if (settled.state !== other.state) {
            state.tasks.set(otherId, settled);
            await push("task", settled, sourceSeq);
          }
        }
        break;
      }
      case "tool/call": {
        const callId = str(payload.callId);
        const name = str(payload.name);
        if (!callId || !name) break;
        const args = parseJson(payload.arguments);
        const call: Call = { callId, name, args };
        state.calls.set(callId, call);
        // 对话调用也存一份：工具结果晚一拍才到，靠它把两半接起来。
        await client.query(
          `insert into swarm_call(account_id,run_id,call_id,name) values($1,$2,$3,$4)
           on conflict (account_id,run_id,call_id) do update set name=excluded.name`,
          [context.account, context.runId, callId, name],
        );
        await push(
          "member_log",
          {
            member: "lead",
            kind: "tool",
            text: `调用 ${name}`,
            tool: { name, state: "running", args: JSON.stringify(args).slice(0, 400) },
          } satisfies Partial<MemberLogItem> & { member: string },
          sourceSeq,
        );
        if (name === "send_message" && str(args.target) === "lead") {
          // 队员 → 负责人：内核事件里分不出是谁发的，由插件带名字上报（见 appendsMemberMessage）。
          break;
        }
        if (name === "send_message") {
          const target = str(args.target);
          const bus: BusEntry = {
            seq: 0,
            at: new Date().toISOString(),
            type: "message",
            from: "lead",
            to: target ?? null,
            text: String(args.message ?? "").slice(0, 2000),
            delivery: "unknown",
            refs: {},
          };
          const seq = await push("bus", bus, sourceSeq);
          if (seq !== null) {
            call.busSeq = seq;
            await client.query(
              `insert into swarm_call(account_id,run_id,call_id,name,bus_seq) values($1,$2,$3,$4,$5)
               on conflict (account_id,run_id,call_id) do update set bus_seq=excluded.bus_seq`,
              [context.account, context.runId, callId, name, seq],
            );
          }
        } else if (name === "interrupt_agent") {
          const bus: BusEntry = {
            seq: 0,
            at: new Date().toISOString(),
            type: "interrupt",
            from: "lead",
            to: str(args.target),
            text: `负责人打断了 ${str(args.target) ?? "一名队员"} 当前的这一轮`,
            refs: {},
          };
          await push("bus", bus, sourceSeq);
        } else if (name === "team_task_create" || name === "research_task") {
          const bus: BusEntry = {
            seq: 0,
            at: new Date().toISOString(),
            type: "broadcast",
            from: "lead",
            to: "board",
            text: `新任务：${String(args.subject ?? args.title ?? "").slice(0, 300)}`,
            refs: {},
          };
          await push("bus", bus, sourceSeq);
        }
        break;
      }
      case "tool/result": {
        const message = obj(payload.message);
        const callId = str(message.toolCallId) ?? str(payload.callId);
        if (!callId) break;
        const call = state.calls.get(callId);
        const failed = message.isError === true;
        if (call?.busSeq) await setDelivery(client, context, call.busSeq, failed ? "failed" : "sent");
        const name = call?.name;
        const value = resultValue(payload);
        // list_agents 的结果是唯一能拿到「谁正在跑」的地方：按它更新名册状态。
        if (name === "list_agents" && !failed) {
          const list = Array.isArray(value) ? value : arr(obj(value).members);
          for (const item of list) {
            const row = obj(item);
            const target = str(row.target) ?? str(row.name);
            if (!target) continue;
            const prior = state.members.get(target);
            if (!prior) continue;
            const status = str(row.status);
            const next: SwarmMember = {
              ...prior,
              state:
                status === "running"
                  ? "running"
                  : status === "provisioning"
                    ? "creating"
                    : status === "failed"
                      ? "failed"
                      : "idle",
            };
            if (next.state !== prior.state) {
              state.members.set(target, next);
              await push("member", next, sourceSeq);
            }
          }
        }
        // 任务认领/完成：队内谁改的都会写进负责人的会话日志。
        if (name === "team_task_update" && !failed && call?.args) {
          const action = str(call.args.action);
          const taskId = str(call.args.task_id);
          const type: BusEntry["type"] =
            action === "claim" ? "claim" : action === "complete" ? "deliver" : "message";
          if (action && type !== "message") {
            const bus: BusEntry = {
              seq: 0,
              at: new Date().toISOString(),
              type,
              from: str(obj(value).ownerName) ?? "lead",
              to: taskId ? null : null,
              text:
                type === "claim"
                  ? `领取了任务 ${taskId ?? ""}`
                  : `交付了任务 ${taskId ?? ""}`,
              refs: taskId ? { taskId } : {},
              taskUpdates: taskId && str(value.status)
                ? [{ id: taskId, state: taskState(str(value.status) as SwarmTask["board"], false) }]
                : [],
            };
            await push("bus", bus, sourceSeq);
          }
        }
        if (name)
          await push(
            "member_log",
            {
              member: "lead",
              kind: "tool",
              text: `${name} ${failed ? "失败" : "完成"}`,
              tool: {
                name,
                state: failed ? "failed" : "done",
                ...(failed
                  ? { result: JSON.stringify(value).slice(0, 400) }
                  : { result: JSON.stringify(value).slice(0, 400) }),
              },
            } satisfies Partial<MemberLogItem> & { member: string },
            sourceSeq,
          );
        if (call) state.calls.set(callId, { ...call, busSeq: undefined });
        break;
      }
      case "user/message": {
        const content = arr(payload.content);
        const text = content.map((block) => str(obj(block).text) ?? "").join("").trim();
        if (!text) break;
        // 队员的消息以「Team message from <名字>:」开头落进负责人会话：
        // 认得出是谁发的就按队内消息记，认不出才是用户说的话。
        const fromTeammate = /^Team message from ([A-Za-z0-9_-]+):\s*([\s\S]*)$/.exec(text);
        const bus: BusEntry = fromTeammate
          ? {
              seq: 0,
              at: new Date().toISOString(),
              type: "message",
              from: fromTeammate[1],
              to: "lead",
              text: fromTeammate[2].slice(0, 2000),
              delivery: "received",
              refs: {},
            }
          : {
              seq: 0,
              at: new Date().toISOString(),
              type: "user",
              from: "user",
              to: "lead",
              text: text.slice(0, 2000),
              refs: {},
            };
        await push("bus", bus, sourceSeq);
        break;
      }
      default:
        if (deps.memberLog) await deps.memberLog(context, payload);
        break;
    }
  }
  return out;
}
