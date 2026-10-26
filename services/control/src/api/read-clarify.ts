import type { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Database } from "../db/database";
import type { HarnessStore } from "../harness/store";
import type { PricingService } from "../budget/pricing";
import { lockBudget, prepareDossierBudget, allocateBudget } from "../budget";
import { decimal } from "../budget/money";
import { appendEvent, requireDossier, scrub } from "../ledger";
import { bindRunCapabilities, loadCapabilityCatalog } from "../mcp/authority";
import { mutate, type ApiEnv, type Receipt } from "./context";
import { ApiFailure, denied } from "./errors";
import type { RuntimeApiPort } from "./runtime";
import { closeClarifications } from '../clarify/lifecycle';
import {
  candidateView,
  currentChoice,
  nativeQuestions,
  pickView,
} from "../clarify/candidates";

const Text = z.object({ text: z.string().trim().min(1).max(1000), approvalId: z.string().uuid().optional(), selectionRevision: z.number().int().nonnegative().optional() }).strict(),
  Empty = z.object({}).strict();
const Pick = z
  .object({
    pickId: z.string().uuid(),
    candidateId: z.string().uuid().nullable(),
  })
  .strict();
const conflict = (message: string) =>
  new ApiFailure("CLARIFY_CONFLICT", 409, message);
async function noFormal(c: any, dossier: string) {
  if (
    (
      await c.query(
        "select id from run where dossier_id=$1 and role_id<>'research-clarify' and ended_at is null and state in ('queued','running','waiting','paused_budget')",
        [dossier]
      )
    ).rowCount
  )
    throw conflict("正式精读尚未停止，不能修改选择。");
}
export async function clarificationView(c: any, dossier: string) {
  const state = (
    await c.query("select * from read_clarification where dossier_id=$1", [
      dossier,
    ])
  ).rows[0];
  const costs = (
    await c.query(
      `select (select coalesce(sum(e.cost_cny),0)::text from event e join run r on r.id=e.run_id where r.dossier_id=$1 and r.role_id='research-clarify' and e.kind='cost' and e.cost_cny is not null) spent,
        exists(select 1 from run r left join os_binding b on b.run_id=r.id where r.dossier_id=$1 and r.role_id='research-clarify' and
          ((coalesce(b.usage_uncertain,false) and not exists(select 1 from event proof join budget_hold h on h.run_id=proof.run_id
             where proof.run_id=r.id and proof.action='clarify_usage_reconciled' and h.state='settled'
             and proof.payload->>'settlementEventSeq'=h.event_seq::text
             and proof.payload->>'usages'=(select count(*)::text from os_usage where run_id=r.id)))
           or exists(select 1 from budget_hold h where h.run_id=r.id and h.state='unpriced')
           or exists(select 1 from runtime_model_request m where m.run_id=r.id and m.state<>'completed')
           or exists(select 1 from clarify_model_request m where m.run_id=r.id and m.state<>'completed')
           or exists(select 1 from event e where e.run_id=r.id and e.kind='cost' and e.cost_cny is null))) unknown`,
      [dossier]
    )
  ).rows[0];
  const fence = (
    await c.query(
      "select count(*)::int rounds,coalesce(sum(reinlab_clarify_reservation(clarify_model_request)),0)::int reserved,coalesce(bool_or(state<>'completed'),false) blocked from clarify_model_request where run_id=(select id from run where dossier_id=$1 and role_id='research-clarify' order by created_at desc,id desc limit 1)",
      [dossier]
    )
  ).rows[0];
  const runs = (
    await c.query(
      "select r.id,r.state,r.input,cr.closed from run r join read_clarify_run cr on cr.run_id=r.id where r.dossier_id=$1 and r.role_id='research-clarify' order by r.created_at,r.id",
      [dossier]
    )
  ).rows;
  const approvals = (
    await c.query(
      `select a.id,a.run_id "runId",a.state,a.decision_sent sent,a.effects from approval a join run r on r.id=a.run_id join os_binding b on b.run_id=a.run_id and b.session_id=a.os_session_id where r.dossier_id=$1 and r.role_id='research-clarify' and a.kind='question' and b.phase='accepted' and b.receipt is not null order by a.id`,
      [dossier]
    )
  ).rows;
  const history: any[] = runs.map((r: any) => ({
    type: "user",
    id: "clarify-user:" + r.id,
    text: r.input.clarifyText,
  }));
  const pendingQuestion = approvals.find((a: any) => a.state === 'pending' && !a.sent &&
    runs.some((r: any) => r.id === a.runId && !r.closed && ['running','waiting'].includes(r.state)) &&
    nativeQuestions(a.effects).length === 1 && nativeQuestions(a.effects)[0].header === 'REINLAB_CLARIFY');
  for (const a of approvals) {
    const pick = await pickView(c, dossier, a);
    if (pick) {
      const choice =
        state?.chosen_approval === a.id ? state.chosen_id : undefined;
      history.push({ ...pick, ...(choice ? { chosen: choice } : {}) });
    } else
      for (const q of nativeQuestions(a.effects))
        history.push({
          type: "agent",
          id: "clarify-question:" + a.id,
          text: q.question,
        });
  }
  for (const r of runs)
    if (
      ["failed", "cancelled", "interrupted", "paused_budget"].includes(
        r.state
      ) &&
      !state?.chosen_id
    )
      history.push({
        type: "agent",
        id: "clarify-stop:" + r.id,
        text: "澄清已停止或被取消；已有检索保留，没有自动重试。可查看收件箱和账本。",
      });
  const unknown = costs.unknown === true || fence.blocked === true;
  if (unknown)
    history.push({
      type: "agent",
      id: "clarify-unknown",
      text: "澄清已有已知花费 + 未知用量；未知部分仍保留预算，不按零记账，也不阻塞其他运行。",
    });
  if (fence.rounds >= 6 || fence.reserved >= 500000)
    history.push({
      type: "agent",
      id: "clarify-cap",
      text: "澄清已达到最多6轮或¥0.5保守费用预留上限，已停止；不会偷偷提高预算。",
    });
  const stopped = (
    await c.query(
      "select seq,payload from event where dossier_id=$1 and action='clarify_model_stopped' order by seq",
      [dossier]
    )
  ).rows;
  for (const e of stopped)
    history.push({
      type: "agent",
      id: "clarify-stopped:" + e.seq,
      text: e.payload.message,
    });
  const messages = (
    await c.query(
      "select e.seq,e.action,e.payload from event e join run r on r.id=e.run_id where r.dossier_id=$1 and r.role_id='research-clarify' and (e.action='clarify_user' or e.action='capability.call' or e.kind='message') order by e.seq",
      [dossier]
    )
  ).rows;
  const assistants = new Set<string>(),
    parts = new Map<string, any>();
  for (const e of messages) {
    const p = e.payload?.properties ?? {};
    if (p.info?.role === "assistant") assistants.add(p.info.id);
    if (p.part?.type === "text" && typeof p.part.text === "string")
      parts.set(p.part.id, p.part);
    if (e.action === "clarify_user")
      history.push({
        type: "user",
        id: "clarify-answer:" + e.seq,
        text: e.payload.text,
      });
    if (e.action === "capability.call")
      history.push({
        type: "tool",
        id: "clarify-tool:" + e.seq,
        action: e.payload.capability,
        label: "公开论文检索",
        state: e.payload.success ? "done" : "failed",
        detail:
          e.payload.summary?.count !== undefined
            ? "命中" + e.payload.summary.count + "篇"
            : undefined,
      });
  }
  for (const part of parts.values())
    if (assistants.has(part.messageID) && part.text.trim())
      history.push({
        type: "agent",
        id: "clarify-text:" + part.id,
        text: part.text,
      });
  const chosen = await currentChoice(c, dossier);
  return {
    spentCny: Number(costs.spent),
    capCny: 0.5,
    unknownCost: unknown,
    rounds: fence.rounds,
    selectionRevision: state?.selection_revision ?? 0,
    chosen: chosen ? candidateView(chosen) : null,
    pendingQuestion: pendingQuestion ? { approvalId: pendingQuestion.id, runId: pendingQuestion.runId } : null,
    activeRunId: [...runs].reverse().find((r: any) => !r.closed && ['queued','running','waiting','paused_budget'].includes(r.state))?.id ?? null,
    history,
  };
}
export function registerReadClarify(
  app: Hono<ApiEnv>,
  db: Database,
  harness: HarnessStore,
  pricing: PricingService,
  pipeline: RuntimeApiPort | undefined,
  queued: ((account: string, run: string) => Promise<void>) | undefined
) {
  app.post('/v1/dossiers/:id/read/cancel-clarify', async c => {
    const account=c.get('accountId'), dossier=c.req.param('id');
    const response=await mutate(c,db,Empty,async client=>{
      await lockBudget(client,account); await requireDossier(client,dossier); await noFormal(client,dossier);
      return {status:202,body:{accepted:true}};
    });
    if (response.status===202) await closeClarifications(db,account,dossier,pipeline);
    return response;
  });
  app.post("/v1/dossiers/:id/read/clarify", async (c) => {
    let nextRun: string | undefined, nextApproval: string | undefined;
    const account = c.get("accountId"),
      dossier = c.req.param("id");
    const rawText = Text.safeParse(await c.req.json().catch(() => null));
    if (rawText.success && pipeline) {
      const pending = await db.withAccount(
        account,
        async (client) =>
          (
            await client.query(
              "select a.* from approval a join run r on r.id=a.run_id join read_clarify_run cr on cr.run_id=r.id where r.dossier_id=$1 and not cr.closed and a.kind='question' and a.state='pending' and not a.decision_sent and ($2::uuid is null or a.id=$2) order by a.id limit 1",
              [dossier, rawText.data.approvalId ?? null]
            )
          ).rows[0]
      );
      if (
        pending &&
        nativeQuestions(pending.effects)[0]?.header !== "REINLAB_PAPER_PICK"
      )
        await pipeline.decisions.validate(account, pending.id, {
          decision: "approve",
          scope: "once",
          answers: [[rawText.data.text]],
        });
    }
    const response = await mutate(
      c,
      db,
      Text,
      async (client, input): Promise<Receipt> => {
        await lockBudget(client, account);
        await requireDossier(client, dossier);
        await noFormal(client, dossier);
        const effective = await harness.effectiveClient(
            client,
            account,
            dossier
          ),
          role = effective.manifest.roles["research-clarify"];
        if (!["1.2.0", "1.2.1", "1.2.2"].includes(effective.manifest.version) || !role?.model_cap)
          throw conflict(
            "当前档案未接澄清，请新建research@1.2.0精读，不会升级旧档案。"
          );
        await client.query(
          "insert into read_clarification(account_id,dossier_id)values($1,$2) on conflict do nothing",
          [account, dossier]
        );
        const s = (
          await client.query(
            "select * from read_clarification where dossier_id=$1 for update",
            [dossier]
          )
        ).rows[0];
        // 回答一个已经存在的问题以 approvalId 为准；只有新开一段澄清才需要选中代次一致，
        // 否则界面刷新慢一拍就会把用户的补充挡掉（run7 C3）。
        if (
          input.selectionRevision !== undefined &&
          input.selectionRevision !== s.selection_revision &&
          !input.approvalId
        )
          throw conflict('澄清已切换或停止，旧输入未另建运行。');
        if (s.chosen_id) throw conflict("请先换一篇，再重新澄清。");
        const active = (
          await client.query(
            "select r.id from run r join read_clarify_run cr on cr.run_id=r.id where r.dossier_id=$1 and not cr.closed and r.state in ('queued','running','waiting','paused_budget') order by r.created_at desc limit 1",
            [dossier]
          )
        ).rows[0];
        if (active) {
          const a = (
            await client.query(
              "select * from approval where run_id=$1 and kind='question' and state='pending' and not decision_sent order by id limit 1",
              [active.id]
            )
          ).rows[0];
          const q = a && nativeQuestions(a.effects);
          if (input.approvalId && input.approvalId !== a?.id)
            throw conflict('待回答的澄清问题已变化，请刷新。');
          if (!a || q.length !== 1 || q[0].header === "REINLAB_PAPER_PICK")
            throw conflict("澄清仍在运行或等待选论文，请先处理当前问题。");
          if (!pipeline)
            throw new ApiFailure(
              "RUNTIME_UNAVAILABLE",
              503,
              "原生澄清交互尚未就绪。"
            );
          nextApproval = a.id;
          await pipeline.decisions.prepare(client, account, a.id, {
            decision: "approve",
            scope: "once",
            answers: [[input.text]],
          });
          await appendEvent(client, account, {
            dossierId: dossier,
            runId: active.id,
            roleId: "research-clarify",
            kind: "message",
            action: "clarify_user",
            payload: { text: input.text },
            dedupeKey: "clarify-answer:" + a.id,
          });
          return { status: 202, body: { approvalId: a.id, runId: active.id, accepted: true } };
        }
        if (input.approvalId) throw conflict('这个澄清已结束，不能另建运行代答。');
        await client.query('update read_clarification set closed=false,selection_revision=selection_revision+1 where dossier_id=$1 and closed',[dossier]);
        const amount = decimal(500000n),
          root = await prepareDossierBudget(client, account, dossier, amount),
          id = randomUUID();
        const roleInput = {
          question: input.text,
          clarifyText: input.text,
          limits: { maxSteps: 6 },
          memoryRefs: [],
        };
        await client.query(
          "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,input) values($1,$2,$3,'research-clarify','read',$4,'queued',$5,$6)",
          [
            id,
            account,
            dossier,
            randomUUID(),
            amount,
            JSON.stringify(scrub(roleInput)),
          ]
        );
        await client.query(
          "insert into run_harness(account_id,dossier_id,run_id,bench,version,effective_digest,model_route)values($1,$2,$3,'research',$4,$5,$6)",
          [account, dossier, id, effective.manifest.version, effective.digest, pricing.route("cheap")]
        );
        await bindRunCapabilities(
          client,
          account,
          id,
          effective,
          "research-clarify",
          roleInput,
          await loadCapabilityCatalog()
        );
        await client.query(
          "insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",
          [account, dossier, id]
        );
        await allocateBudget(client, account, {
          dossierId: dossier,
          runId: id,
          parentId: root.id,
          amountCny: amount,
        });
        await appendEvent(client, account, {
          dossierId: dossier,
          runId: id,
          roleId: "research-clarify",
          kind: "gate",
          action: "clarify_queued",
          payload: {
            automatic: true,
            capCny: "0.500000",
            model: pricing.route("cheap"),
            confirmedPurpose: "clarification_only",
          },
          dedupeKey: "clarify-queued:" + id,
        });
        nextRun = id;
        return { status: 201, body: { runId: id, accepted: true } };
      }
    );
    if (nextApproval)
      await pipeline!.decisions.dispatch(account, nextApproval).catch(() => {});
    if (nextRun && queued) await queued(account, nextRun).catch(() => {});
    return response;
  });
  app.post("/v1/dossiers/:id/read/pick", async (c) => {
    const account = c.get("accountId"),
      dossier = c.req.param("id");
    let approval: string | undefined;
    const rawPick = Pick.safeParse(await c.req.json().catch(() => null));
    if (rawPick.success && pipeline) {
      const { answered, paperId } = await db.withAccount(
        account,
        async (client) => {
          const a = (
            await client.query(
              "select a.*,a.run_id \"runId\",a.decision_sent sent from approval a join run r on r.id=a.run_id where a.id=$1 and r.dossier_id=$2 and r.role_id='research-clarify'",
              [rawPick.data.pickId, dossier]
            )
          ).rows[0];
          if (!a) throw denied();
          const view = await pickView(client, dossier, a),
            chosen = view?.candidates.find(
              (p: any) => p.id === rawPick.data.candidateId
            );
          if (rawPick.data.candidateId !== null && !chosen)
            throw conflict("候选不属于当前问题。");
          return {
            answered: a.state === "approved",
            paperId: chosen?.paperId ?? "都不是",
          };
        }
      );
      // 已回答过的候选卡在「换一篇」之后改选：不调模型，只换本地选定。
      if (!answered)
        await pipeline.decisions.validate(account, rawPick.data.pickId, {
          decision: "approve",
          scope: "once",
          answers: [[paperId]],
        });
    }
    const response = await mutate(c, db, Pick, async (client, input) => {
      await lockBudget(client, account);
      await requireDossier(client, dossier);
      await noFormal(client, dossier);
      const row = (
        await client.query(
          `select a.*,a.run_id "runId",a.decision_sent sent,b.phase,b.receipt from approval a join run r on r.id=a.run_id join os_binding b on b.run_id=a.run_id and b.session_id=a.os_session_id where a.id=$1 and r.dossier_id=$2 and r.role_id='research-clarify' for update of a`,
          [input.pickId, dossier]
        )
      ).rows[0];
      if (!row || row.kind !== "question")
        throw conflict("候选问题已变化，不能重复选择。");
      const view = await pickView(client, dossier, row),
        candidate = view?.candidates.find(
          (p: any) => p.id === input.candidateId
        );
      if (!view || (input.candidateId !== null && !candidate))
        throw conflict("论文不属于当前检索问题。");
      if (row.state === "approved" && row.sent) {
        // 换一篇之后的改选：沿用这张已答的候选卡，只把选定的论文换成新的。
        // 换一篇会把这段澄清关上；改选仍允许，沿用这张已答的候选卡。
        const current = (
          await client.query(
            "select chosen_id,selection_revision from read_clarification where dossier_id=$1 for update",
            [dossier]
          )
        ).rows[0];
        if (!current) throw conflict("这段澄清已经结束，请重新说一次。");
        if (current.chosen_id === input.candidateId)
          return {
            status: 200,
            body: { accepted: true, pickId: row.id, repicked: false },
          };
        if (current.chosen_id !== null)
          throw conflict("已经选了别的论文，请先换一篇。");
        await client.query(
          "update read_clarification set chosen_id=$2,chosen_approval=$3,selection_revision=selection_revision+1 where dossier_id=$1",
          [dossier, input.candidateId, row.id]
        );
        await appendEvent(client, account, {
          dossierId: dossier,
          runId: row.runId,
          roleId: "research-clarify",
          kind: "message",
          action: "clarify_repick",
          payload: {
            paperId: candidate?.paperId ?? "都不是",
            candidateId: input.candidateId,
            approvalId: row.id,
          },
          dedupeKey:
            "repick:" + row.id + ":" + String(input.candidateId ?? "none"),
        });
        return {
          status: 201,
          body: { accepted: true, pickId: row.id, repicked: true },
        };
      }
      if (
        row.phase !== "accepted" ||
        !row.receipt ||
        row.state !== "pending" ||
        row.sent
      )
        throw conflict("候选问题已变化，不能重复选择。");
      if (!pipeline)
        throw new ApiFailure(
          "RUNTIME_UNAVAILABLE",
          503,
          "原生问题决定尚未就绪。"
        );
      await pipeline.decisions.prepare(client, account, row.id, {
        decision: "approve",
        scope: "once",
        answers: [[candidate?.paperId ?? "都不是"]],
      });
      approval = row.id;
      return {
        status: 202,
        body: { accepted: true, pickId: row.id, repicked: false },
      };
    });
    if (approval) {
      await pipeline!.decisions.dispatch(account, approval).catch(() => {});
    }
    return response;
  });
  app.post("/v1/dossiers/:id/read/unchoose", async (c) => {
    const response=await mutate(c, db, Empty, async (client) => {
      const dossier = c.req.param("id");
      await lockBudget(client, c.get("accountId"));
      await requireDossier(client, dossier);
      await noFormal(client, dossier);
      const pending = (
        await client.query(
          "select s.chosen_id,a.state,a.decision_sent from read_clarification s left join approval a on a.id=s.chosen_approval where s.dossier_id=$1 for update of s",
          [dossier]
        )
      ).rows[0];
      if (pending?.chosen_id && pending.state !== "approved")
        throw conflict("选择结果尚未核对，不能覆盖。");
      await client.query(
        "update read_clarification set chosen_id=null,chosen_approval=null,closed=false,selection_revision=selection_revision+1 where dossier_id=$1",
        [dossier]
      );
      await appendEvent(client, c.get("accountId"), {
        dossierId: dossier,
        kind: "message",
        action: "clarify_unchoose",
        payload: {},
        dedupeKey: "unchoose:" + randomUUID(),
      });
      return { status: 200, body: { cleared: true } };
    });
    if (response.status===200) await closeClarifications(db,c.get('accountId'),c.req.param('id'),pipeline);
    return response;
  });
}
