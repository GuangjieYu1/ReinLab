import { it, expect } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelFixture } from "./kernel-fixture";
import { createApp } from "../src/api/app";
import { SwarmService } from "../src/swarm/service";
import { KernelAuth } from "../src/kernel/auth";
import { KernelService } from "../src/kernel/service";
import type { HarnessFactory } from "../src/kernel/dsh/session";

const HOME = mkdtempSync(join(tmpdir(), "swarm-blackboard-"));

const io = {
  mkdir: async (path: string) => void (await mkdir(path, { recursive: true, mode: 0o700 })),
  write: async (file: string, body: string) => void (await writeFile(file, body, { mode: 0o600 })),
  remove: async (file: string) => void (await rm(file, { force: true })),
};

/** 这一档只需要一个不建队、不说话的内核：黑板逻辑全部走服务。 */
function quietKernel(): HarnessFactory {
  return () => ({
    session: (id: string) => ({
      run: async () => ({
        sessionId: id,
        events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
        finalResponse: "",
      }),
    }),
    resumeSession: async () => ({
      run: async () => ({
        sessionId: "ds-quiet",
        events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
        finalResponse: "",
      }),
    }),
    close: async () => {},
  });
}

async function setup() {
  const f = await kernelFixture();
  const kernel = new KernelService({
    db: f.db,
    auth: new KernelAuth(generateKeyPairSync("ed25519").privateKey),
    factory: quietKernel(),
    model: "deepseek-v4-flash",
    maxTokens: 4096,
    controlUrl: "http://control:3001",
    layout: {
      home: HOME,
      shimModule: "/app/shim.mjs",
      shimContainerModule: "/app/shim.mjs",
      dshModule: "/app/dsh.mjs",
      restrictPatch: "/opt/restrict.patch.yml",
      pluginEntry: "file:///opt/plugin/index.js",
      swarmPluginEntry: "file:///opt/swarm/index.js",
      shimMode: "host",
      io,
    },
  });
  const swarm = new SwarmService({ db: f.db, kernel, model: "deepseek-v4-flash" });
  kernel.attachSwarm(swarm);
  const created = await swarm.start(f.account, f.dossier, "多 Agent 数量增加是否一定提高研究质量？");
  await swarm.publishPlan(f.account, created.runId, {
    question: "多 Agent 数量增加是否一定提高研究质量？",
    scope: "只查 LLM 多智能体实证研究",
    qualityCriteria: ["有对照实验"],
    routes: [
      { id: "r1", title: "规模曲线", idea: "把 agent 数当自变量", differsBy: "看曲线" },
      { id: "r2", title: "机制与失效", idea: "看聚合与同质化", differsBy: "看机制" },
    ],
    limits: { rounds: 4, minutes: 30 },
  });
  await swarm.confirmPlan(f.account, created.runId, { planVersion: 1 });
  // 队员与路线的登记（MVP-1 的 research_spawn 做的是这件事）。
  await swarm.registerMeta(f.account, created.runId, {
    kind: "member",
    refId: "r1-scout",
    data: { role: "researcher", label: "研究员 01", routeId: "r1" },
  });
  await swarm.registerMeta(f.account, created.runId, {
    kind: "member",
    refId: "r2-mech",
    data: { role: "researcher", label: "研究员 02", routeId: "r2" },
  });
  await swarm.registerMeta(f.account, created.runId, {
    kind: "member",
    refId: "critic",
    data: { role: "critic", label: "反驳 01", routeId: null },
  });
  await swarm.registerMeta(f.account, created.runId, {
    kind: "member",
    refId: "verifier",
    data: { role: "verifier", label: "核实 01", routeId: null },
  });
  return { f, kernel, swarm, runId: created.runId };
}

const evidenceOf = (ref: string, section: string, quote: string) => ({
  source: { kind: "paper", title: "More Agents Is All You Need", ref, version: "v2" },
  locator: { section, quote },
  access: "full_text",
  how: "arXiv HTML 全文",
});

it("黑板：提交结论与证据、追到任务与来源、汇总只出候选、同来源同定位去重、提交幂等", async () => {
  const { f, swarm, runId } = await setup();
  try {
    const submitted = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "sub-1",
      member: "r1-scout",
      taskId: "task-1",
      claim: {
        text: "在同预算下，agent 数从 1 增到 4 时准确率上升，超过 4 之后收益趋平。",
        basis: "checked_fact",
        conditions: ["同一任务族", "同预算"],
      },
      evidence: [evidenceOf("arXiv:2401.00001", "Table 2", "accuracy rises from 61.2 to 71.4")],
    });
    expect(submitted.claimIds).toHaveLength(1);
    expect(submitted.evidenceIds).toHaveLength(1);

    // 换一次提交、同样的来源与定位：证据不重复记，引用照样成立。
    const second = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "sub-2",
      member: "r1-scout",
      taskId: "task-1",
      claim: {
        text: "同一张表里，agent 数超过 8 之后方差变大，均值不再上升。",
        basis: "checked_fact",
        conditions: ["同一任务族"],
      },
      evidence: [evidenceOf("arXiv:2401.00001", "Table 2", "accuracy rises from 61.2 to 71.4")],
    });
    expect(second.evidenceIds).toEqual(submitted.evidenceIds);

    const snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.claims).toHaveLength(2);
    expect(snapshot.evidence).toHaveLength(1);
    // 阶段结果：核实没接通 → verified 为空、候选进 unverified、没有正式答案。
    expect(snapshot.report).not.toBeNull();
    expect(snapshot.report!.verified).toEqual([]);
    expect(snapshot.report!.answer).toBeNull();
    expect(snapshot.report!.unverified).toHaveLength(2);
    expect(snapshot.report!.sources).toEqual([submitted.evidenceIds[0]]);

    // 结论详情：一路追到证据、任务、队员。
    const detail = await swarm.claimDetail(f.account, runId, submitted.claimIds[0]);
    expect(detail.claim.evidenceIds).toEqual(submitted.evidenceIds);
    expect(detail.evidence[0].source.ref).toBe("arXiv:2401.00001");
    expect(detail.evidence[0].locator).toMatchObject({ section: "Table 2" });
    expect(detail.member).toMatchObject({ id: "r1-scout", label: "研究员 01", role: "researcher" });

    // 证据详情：哪几条结论引用了它。
    const evidenceDetail = await swarm.evidenceDetail(f.account, runId, submitted.evidenceIds[0]);
    expect(evidenceDetail.referencedBy).toHaveLength(2);

    // 提交幂等：同一个 submission_id 重试，原样返回，不记第二遍。
    const retried = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "sub-1",
      member: "r1-scout",
      claim: { text: "重试的一条不该出现", basis: "inference" },
      evidence: [evidenceOf("arXiv:2401.00002", "§3", "quote")],
    });
    expect(retried.repeated).toBe(true);
    expect(retried.claimIds).toEqual(submitted.claimIds);
    const after = await swarm.snapshot(f.account, runId);
    expect(after.claims).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 120_000);

it("黑板：结论没有证据又不写负结果就拒；负结果可以单独成立", async () => {
  const { f, swarm, runId } = await setup();
  try {
    await expect(
      swarm.submitResearch(f.account, runId, {
        kind: "claim",
        submissionId: "sub-empty",
        member: "r1-scout",
        claim: { text: "加人一定更好，我觉得是这样。", basis: "inference" },
      }),
    ).rejects.toThrow(/证据|负结果/);

    const negative = await swarm.submitResearch(f.account, runId, {
      kind: "negative",
      submissionId: "sub-neg",
      member: "r2-mech",
      claim: {
        text: "没有找到「加人导致质量下降」的直接反例。",
        negative: { searched: "arXiv cs.MA", scope: "2024–2026", notFound: "没有直接反例" },
      },
    });
    expect(negative.claimIds).toHaveLength(1);
    const snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.report!.negative).toEqual([negative.claimIds[0]]);

    // 负结果没有证据：详情就该是空的，不能把整块黑板的证据带回来（B6）。
    await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "sub-with-ev",
      member: "r1-scout",
      claim: { text: "另一条带证据的结论，用来确认黑板里确实有证据。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00031", "Table 9", "quote")],
    });
    const negativeDetail = await swarm.claimDetail(f.account, runId, negative.claimIds[0]);
    expect(negativeDetail.claim.evidenceIds).toEqual([]);
    expect(negativeDetail.evidence).toEqual([]);
  } finally {
    await f.close();
  }
}, 120_000);

it("黑板：独立阶段研究员只看自己路线，反驳和负责人看全部", async () => {
  const { f, swarm, runId } = await setup();
  try {
    await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "r1-claim",
      member: "r1-scout",
      routeId: "r1",
      claim: { text: "r1 的候选结论：曲线在 4 附近趋平。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00011", "Table 1", "plateau at 4")],
    });
    await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "r2-claim",
      member: "r2-mech",
      routeId: "r2",
      claim: { text: "r2 的候选结论：同质化会让收益反转。", basis: "inference" },
      evidence: [evidenceOf("arXiv:2401.00012", "§4", "homogeneity hurts")],
    });

    const own = await swarm.queryResearch(f.account, runId, { member: "r1-scout" });
    expect(own.phase).toBe("independent");
    expect(own.claims.map((claim) => claim.routeId)).toEqual(["r1"]);

    // 反驳 / 负责人不受这条裁剪限制。
    const critic = await swarm.queryResearch(f.account, runId, { member: "critic" });
    expect(critic.claims).toHaveLength(2);
    const lead = await swarm.queryResearch(f.account, runId, { member: "lead" });
    expect(lead.claims).toHaveLength(2);

    // 进入第 3 轮（交叉阶段）之后，研究员也能读到别的路线。
    await f.admin.query("update swarm_run set round=3 where run_id=$1", [runId]);
    const crossed = await swarm.queryResearch(f.account, runId, { member: "r1-scout" });
    expect(crossed.phase).toBe("cross");
    expect(crossed.claims).toHaveLength(2);
  } finally {
    await f.close();
  }
}, 120_000);

it("黑板：登记路线同义不新开、标阻塞要原因、重开要新机制；问题求助决定落成留言", async () => {
  const { f, swarm, runId } = await setup();
  try {
    const first = await swarm.registerApproach(f.account, runId, {
      title: "失效机理的对照拆解",
      idea: "按失败模式分类逐条找反例，不碰数量轴",
      approachFamily: "failure-taxonomy",
    });
    expect(first.created).toBe(true);
    const same = await swarm.registerApproach(f.account, runId, {
      title: "失效机理的对照拆解",
      idea: "按失败模式分类逐条找反例，不碰数量轴",
      approachFamily: "failure-taxonomy",
    });
    expect(same.created).toBe(false);
    expect(same.route.id).toBe(first.route.id);

    // 同义改写不新开：标题展开、换了方法族，也算同一条（E7）。
    const expanded = await swarm.registerApproach(f.account, runId, {
      title: "失效机理的对照拆解：按失败模式分类、逐条找反例",
      idea: "按失败模式分类逐条找反例，不碰数量轴（换了个方法族写法）",
      approachFamily: "failure-taxonomy-v2",
    });
    expect(expanded.created).toBe(false);
    expect(expanded.route.id).toBe(first.route.id);
    // 自己造一个不存在的 id，但内容明显是同一条：并到已有的那条上。
    const alias = await swarm.registerApproach(f.account, runId, {
      routeId: "r-9",
      title: "失效机理的对照拆解",
      idea: "按失败模式分类逐条找反例，不碰数量轴",
    });
    expect(alias.created).toBe(false);
    expect(alias.route.id).toBe(first.route.id);

    await expect(
      swarm.registerApproach(f.account, runId, {
        routeId: first.route.id,
        title: "失效机理的对照拆解",
        state: "blocked",
      }),
    ).rejects.toThrow(/阻塞/);

    const blocked = await swarm.registerApproach(f.account, runId, {
      routeId: first.route.id,
      title: "失效机理的对照拆解",
      state: "blocked",
      blockedReason: "arXiv 连续 429，拿不到全文",
      gap: "缺 Table 2 的逐条数字",
    });
    expect(blocked.route.state).toBe("blocked");

    await expect(
      swarm.registerApproach(f.account, runId, {
        routeId: first.route.id,
        title: "规模扫描",
        state: "reopened",
      }),
    ).rejects.toThrow(/新机制/);
    const reopened = await swarm.registerApproach(f.account, runId, {
      routeId: first.route.id,
      title: "失效机理的对照拆解",
      state: "reopened",
      reopenReason: "改用官方 HTML 全文，不再依赖 PDF 下载",
    });
    expect(reopened.route.state).toBe("reopened");

    // 留言：问题 / 求助 / 决定各一条，问题可以指给某个人。
    const question = await swarm.submitResearch(f.account, runId, {
      kind: "question",
      submissionId: "q-1",
      member: "r1-scout",
      text: "同预算下要不要把采样次数也算进调用量？",
      post: { text: "同预算下要不要把采样次数也算进调用量？", to: "lead" },
    });
    const help = await swarm.submitResearch(f.account, runId, {
      kind: "help",
      submissionId: "h-1",
      member: "r2-mech",
      text: "arXiv 429 了，谁能给个能读全文的入口？",
      post: { text: "arXiv 429 了，谁能给个能读全文的入口？" },
    });
    const decision = await swarm.submitResearch(f.account, runId, {
      kind: "decision",
      submissionId: "d-1",
      member: "lead",
      text: "决定：比较口径统一为「同总 token 预算」。",
      post: { text: "决定：比较口径统一为「同总 token 预算」。" },
    });
    expect([question.postIds.length, help.postIds.length, decision.postIds.length]).toEqual([1, 1, 1]);

    const snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.posts.map((post) => post.col)).toEqual(["question", "help", "decision"]);
    expect(snapshot.posts[0].to).toBe("lead");
    // 路线状态进了快照（含缺口与阻塞原因）。
    const route = snapshot.routes.find((entry) => entry.id === first.route.id);
    expect(route?.state).toBe("reopened");
    expect(route?.gap).toContain("Table 2");

    // 收尾：路线要跟着停，而且库里也落下来（只推事件的话快照还是「进行中」）。
    await swarm.createIntervention(f.account, runId, { kind: "finish" });
    const settled = await swarm.snapshot(f.account, runId);
    expect(settled.run.state).toBe("partial");
    expect(settled.routes.every((entry) => entry.state === "stopped")).toBe(true);
  } finally {
    await f.close();
  }
}, 120_000);

it("E8：负责人上一句「还在待确认」，用户确认后立刻纠正成系统说明", async () => {
  const f = await kernelFixture();
  try {
    const kernel = new KernelService({
      db: f.db,
      auth: new KernelAuth(generateKeyPairSync("ed25519").privateKey),
      factory: quietKernel(),
      model: "deepseek-v4-flash",
      maxTokens: 4096,
      controlUrl: "http://control:3001",
      layout: {
        home: HOME,
        shimModule: "/app/shim.mjs",
        shimContainerModule: "/app/shim.mjs",
        dshModule: "/app/dsh.mjs",
        restrictPatch: "/opt/restrict.patch.yml",
        pluginEntry: "file:///opt/plugin/index.js",
        swarmPluginEntry: "file:///opt/swarm/index.js",
        shimMode: "host",
        io,
      },
    });
    const swarm = new SwarmService({ db: f.db, kernel, model: "deepseek-v4-flash" });
    kernel.attachSwarm(swarm);
    const created = await swarm.start(f.account, f.dossier, "多 Agent 数量与质量");
    await swarm.publishPlan(f.account, created.runId, {
      question: "多 Agent 数量与质量",
      scope: "只查 LLM 多智能体",
      qualityCriteria: ["有对照"],
      routes: [{ id: "r1", title: "规模曲线", idea: "看曲线", differsBy: "看曲线" }],
      limits: { rounds: 4, minutes: 30 },
    });
    // 负责人这一轮结束时计划还没确认：它说「还没确认」在当时没错。
    await swarm.onTurnOutput(
      f.account,
      created.runId,
      "计划卡在研究台那边还是「待确认」状态，我这边不能替你把自己交的计划批准掉——所以我现在还不能建队。",
    );
    await swarm.confirmPlan(f.account, created.runId, { planVersion: 1 });
    const bus = (
      await f.admin.query(
        `select data from swarm_event where run_id=$1 and type='bus' order by seq`,
        [created.runId],
      )
    ).rows.map((row) => row.data as { type: string; text: string });
    // 确认之后补一条系统说明，别让用户以为卡住了。
    expect(
      bus.some((entry) => entry.type === "system" && /已经过期/.test(entry.text)),
    ).toBe(true);
  } finally {
    await f.close();
  }
}, 120_000);

it("黑板接口：结论详情、证据详情、阶段结果都能按契约形状取到", async () => {
  const { f, swarm, runId } = await setup();
  try {
    const submitted = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "http-1",
      member: "r1-scout",
      taskId: "task-1",
      claim: { text: "同预算下 agent 数超过 4 之后收益趋平。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00021", "Table 2", "plateau after 4")],
    });
    const app = await createApp({
      pool: f.pool,
      auth: { issuer: "https://swarm-board.fixture/auth/v1", secret: randomUUID() },
      kernel: undefined,
      swarm,
    });
    const cookie = await f.sessionCookie();
    const get = (path: string) =>
      app.request(path, { headers: { Cookie: cookie } });

    const claim = await get(`/v1/swarm/runs/${runId}/claims/${submitted.claimIds[0]}`);
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as any;
    expect(claimBody.claim).toMatchObject({ id: submitted.claimIds[0], version: 1, status: "candidate" });
    expect(claimBody.claim.evidenceIds).toEqual(submitted.evidenceIds);
    expect(claimBody.evidence[0].source.ref).toBe("arXiv:2401.00021");
    expect(claimBody.member.id).toBe("r1-scout");
    expect(claimBody.reviews).toEqual([]);

    const evidence = await get(`/v1/swarm/runs/${runId}/evidence/${submitted.evidenceIds[0]}`);
    expect(evidence.status).toBe(200);
    expect(((await evidence.json()) as any).referencedBy[0].claimId).toBe(submitted.claimIds[0]);

    const report = await get(`/v1/swarm/runs/${runId}/report`);
    expect(report.status).toBe(200);
    const reportBody = (await report.json()) as any;
    expect(reportBody.state).toBe("stage");
    expect(reportBody.verified).toEqual([]);
    expect(reportBody.answer).toBeNull();
    expect(reportBody.unverified).toEqual([submitted.claimIds[0]]);
    expect(reportBody.sources).toEqual([submitted.evidenceIds[0]]);

    // 阶段结果变了要推一条 report 事件（页面不刷新也能更新汇总面）。
    const reports = (
      await f.admin.query(
        "select data from swarm_event where run_id=$1 and type='report' order by seq",
        [runId],
      )
    ).rows;
    expect(reports.length).toBeGreaterThan(0);
    expect((reports.at(-1)!.data as any).unverified).toContain(submitted.claimIds[0]);

    // 不存在的结论 / 证据给 404，不拿空对象冒充。
    expect((await get(`/v1/swarm/runs/${runId}/claims/${randomUUID()}`)).status).toBe(404);
    expect((await get(`/v1/swarm/runs/${runId}/evidence/${randomUUID()}`)).status).toBe(404);
  } finally {
    await f.close();
  }
}, 120_000);

it("审查与门禁：独立反驳、独立核实、两份人、改版作废、两轮上限、报告分区", async () => {
  const { f, swarm, runId } = await setup();
  try {
    // 交一条结论（r1 研究员），由反驳员和核实员分别审。
    const submitted = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "rev-claim",
      member: "r1-scout",
      claim: {
        text: "同预算下 agent 数超过 4 之后质量不再上升。",
        basis: "checked_fact",
        conditions: ["同一任务族"],
      },
      evidence: [evidenceOf("arXiv:2401.00041", "Table 3", "plateau after 4")],
    });
    const claimId = submitted.claimIds[0];

    // 不能审自己。
    await expect(
      swarm.reviewResearch(f.account, runId, {
        member: "r1-scout",
        claimId,
        kind: "refute",
        verdict: "upheld",
        reason: "自己反驳自己",
      }),
    ).rejects.toThrow(/不能审自己/);

    // 核实必须带自己的证据、且不能只复述。
    await expect(
      swarm.reviewResearch(f.account, runId, {
        member: "critic",
        claimId,
        kind: "verify",
        verdict: "verified",
        reason: "我看了原文",
      }),
    ).rejects.toThrow(/证据/);

    // 反驳成立 → 有争议。
    const refute = await swarm.reviewResearch(f.account, runId, {
      member: "critic",
      claimId,
      kind: "refute",
      verdict: "upheld",
      reason: "表 3 只报了 4 之后的分差，没有控制预算，不能推出「不再上升」。",
    });
    expect(refute.claim.status).toBe("disputed");
    expect(refute.claim.refuteRounds).toBe(1);

    // 反驳者不能再给同一条结论签核实（反驳与核实分人）。
    await expect(
      swarm.reviewResearch(f.account, runId, {
        member: "critic",
        claimId,
        kind: "verify",
        verdict: "verified",
        reason: "我回去复核了一遍，觉得可以签核实。",
        evidence: [evidenceOf("arXiv:2401.00041", "Table 3", "plateau after 4")],
      }),
    ).rejects.toThrow(/分开人做/);

    // 这一版还有没解决的反驳：不能直接签核实，必须先改版本。
    await expect(
      swarm.reviewResearch(f.account, runId, {
        member: "verifier",
        claimId,
        kind: "verify",
        verdict: "verified",
        reason: "回到 §5.2 的 Table 3，固定预算那一列确实在 4 之后持平。",
        evidence: [evidenceOf("arXiv:2401.00041", "§5.2 Table 3", "flat after N=4 under fixed budget")],
      }),
    ).rejects.toThrow(/没解决的反驳/);

    // 改版（补上限定条件）之后才能核实。
    await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "rev-claim-1b",
      member: "r1-scout",
      claim: {
        claimId,
        text: "同预算下 agent 数超过 4 之后质量不再上升（限定：同模型、同提示词、同一任务族）。",
        basis: "checked_fact",
        conditions: ["同一任务族", "同模型同提示词"],
      },
      evidence: [evidenceOf("arXiv:2401.00041", "Table 3", "plateau after 4")],
    });
    const verify = await swarm.reviewResearch(f.account, runId, {
      member: "verifier",
      claimId,
      kind: "verify",
      verdict: "verified",
      reason: "回到 §5.2 的 Table 3，固定预算那一列确实在 4 之后持平。",
      evidence: [evidenceOf("arXiv:2401.00041", "§5.2 Table 3", "flat after N=4 under fixed budget")],
    });
    expect(verify.claim.status).toBe("verified");
    // 反驳 1 条 + 核实 1 条（中间那次被拒的核实不留记录）。
    expect(verify.claim.reviews).toHaveLength(2);

    // 门禁：这条已核实，进正式报告的 verified；answer 取它。
    // 快照里这条也带得出审查记录（页面不打开详情就能看「有几条审查」）。
    let snapshot = await swarm.snapshot(f.account, runId);
    const inSnapshot = snapshot.claims.find((claim) => claim.id === claimId)!;
    expect(inSnapshot.reviews.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.reviews.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.report!.verified).toEqual([claimId]);
    expect(snapshot.report!.answer).toContain("同预算下 agent 数超过 4");

    // 再改一次版：旧的核实作废，不再算已核实。
    const revised = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "rev-claim-2",
      member: "r1-scout",
      claim: {
        claimId,
        text: "同预算下 agent 数超过 4 之后质量不再上升（限定：同模型、同提示词、同一任务族、同一预算口径）。",
        basis: "checked_fact",
        conditions: ["同一任务族", "同模型同提示词", "同预算口径"],
      },
      evidence: [evidenceOf("arXiv:2401.00041", "Table 3", "plateau after 4")],
    });
    expect(revised.claimIds).toEqual([claimId]);
    snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.report!.verified).toEqual([]);
    expect(snapshot.report!.answer).toBeNull();
    expect(snapshot.report!.unverified).toContain(claimId);

    // 两轮反驳上限：第二轮到顶，第三轮拒。
    const second = await swarm.reviewResearch(f.account, runId, {
      member: "critic",
      claimId,
      kind: "refute",
      verdict: "upheld",
      reason: "补充：这张表用的是 AlpacaEval，换任务未必成立。",
    });
    expect(second.claim.refuteRounds).toBe(2);
    await expect(
      swarm.reviewResearch(f.account, runId, {
        member: "critic",
        claimId,
        kind: "refute",
        verdict: "upheld",
        reason: "还想再驳一次",
      }),
    ).rejects.toThrow(/反驳过/);

    // 自动到限结束、但还有分歧 → awaiting_review（报告状态也跟着走），不硬写成完成。
    await f.admin.query("update swarm_run set round=limit_rounds where run_id=$1", [runId]);
    await swarm.onTurnEnd(f.account, runId, "completed");
    snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.run.state).toBe("awaiting_review");
    expect(snapshot.report!.state).toBe("awaiting_review");
    expect(snapshot.report!.disputed).toContain(claimId);
  } finally {
    await f.close();
  }
}, 120_000);

it("多轮推进：轮次与阶段由服务端推进，临近额度给 near_limit 与追加建议", async () => {
  const { f, kernel, swarm, runId } = await setup();
  const quiet = async () => {
    for (let i = 0; i < 100 && kernel.liveTurns(runId) > 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  try {
    // 没有任务、没有结论时不会「答完」：先跑起来看轮次怎么推。
    // 交一条候选结论（不核实），这就是「还有未核实的结论」。
    await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "round-claim",
      member: "r1-scout",
      claim: { text: "同预算下 agent 数超过 4 之后质量趋于平坦。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00051", "Table 5", "flat after 4")],
    });

    // 第 2 轮：仍是独立阶段（负责人交完一批也不能收尾，还有候选要核）。
    await quiet();
    await swarm.onTurnEnd(f.account, runId, "completed");
    let run = await swarm.run(f.account, runId);
    expect(run.round).toBe(2);
    expect(run.phase).toBe("independent");

    // 第 3 轮：进交叉阶段。
    await quiet();
    await swarm.onTurnEnd(f.account, runId, "completed");
    run = await swarm.run(f.account, runId);
    expect(run.round).toBe(3);
    expect(run.phase).toBe("cross");

    // 一回合跑得久也要在 80% 时长切 near_limit：这里把活动时长顶到 85% 再看快照。
    await f.admin.query("update swarm_run set active_ms=$2 where run_id=$1", [
      runId,
      Math.round(30 * 60_000 * 0.85),
    ]);
    let near = await swarm.snapshot(f.account, runId);
    expect(near.run.state).toBe("near_limit");
    expect(near.report!.nextSuggestion).toMatchObject({ rounds: 2 });
    // 到限收尾之后建议也要留着（用户看着它决定要不要追加）。
    await f.admin.query("update swarm_run set state='partial' where run_id=$1", [runId]);
    const endedNear = await swarm.snapshot(f.account, runId);
    expect(endedNear.report!.nextSuggestion).toMatchObject({ rounds: 2 });
    await f.admin.query("update swarm_run set active_ms=0, state='running' where run_id=$1", [runId]);

    // 推进到最后一轮 → 同样进 near_limit（仍在跑），并在 report 里给出追加建议。
    await quiet();
    await swarm.onTurnEnd(f.account, runId, "completed");
    run = await swarm.run(f.account, runId);
    expect(run.round).toBe(4);
    expect(run.state).toBe("near_limit");
    const snapshot = await swarm.snapshot(f.account, runId);
    expect(snapshot.report!.nextSuggestion).toMatchObject({ rounds: 2 });
    expect(snapshot.report!.nextSuggestion!.why).toContain("剩余缺口");
    expect(snapshot.report!.state).toBe("stage");
  } finally {
    await f.close();
  }
}, 120_000);

it("B10：负责人交完一批但还有未核实的结论时，服务端推进下一轮并把缺口交回去", async () => {
  const { f, kernel, swarm, runId } = await setup();
  const quiet = async () => {
    for (let i = 0; i < 100 && kernel.liveTurns(runId) > 0; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 20));
  };
  try {
    // 一条候选结论（没核实）：这就是下一轮要补的缺口。
    const submitted = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "b10-claim",
      member: "r1-scout",
      claim: { text: "同预算下 agent 数超过 4 之后质量趋于平坦。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00061", "Table 6", "flat after 4")],
    });
    const prompts: string[] = [];
    const realSubmit = kernel.submit.bind(kernel);
    kernel.submit = (async (account: string, run: string, options: any = {}) => {
      if (typeof options.prompt === "string") prompts.push(options.prompt);
      return realSubmit(account, run, options);
    }) as typeof kernel.submit;

    await quiet();
    await swarm.onTurnEnd(f.account, runId, "completed");
    const run = await swarm.run(f.account, runId);
    // 收尾条件都不满足（问题还没通过核实）：推进到第 2 轮，不结束。
    expect(run.state).toBe("running");
    expect(run.round).toBe(2);
    // 提示里把未核实的结论当缺口交回负责人，而不是教它分轮。
    const last = prompts.at(-1) ?? "";
    expect(last).toContain(submitted.claimIds[0]);
    expect(last).toContain("还没有通过独立核实");
    expect(last).not.toMatch(/第 [0-9]+ 轮/);

    // 核实通过之后就不再推进：按「问题已回答且通过核实」收尾。
    await swarm.reviewResearch(f.account, runId, {
      member: "critic",
      claimId: submitted.claimIds[0],
      kind: "refute",
      verdict: "rejected",
      reason: "我试着反驳，没找到反例，这一版站得住。",
    });
    await swarm.reviewResearch(f.account, runId, {
      member: "verifier",
      claimId: submitted.claimIds[0],
      kind: "verify",
      verdict: "verified",
      reason: "回到 Table 6 逐字核对，固定预算那一列确实在 4 之后持平。",
      evidence: [evidenceOf("arXiv:2401.00061", "Table 6", "flat after 4")],
    });
    await quiet();
    await swarm.onTurnEnd(f.account, runId, "completed");
    const done = await swarm.run(f.account, runId);
    expect(done.state).not.toBe("running");
    expect(done.stateReason ?? "").toContain("通过核实（1 条）");
    expect(done.stateReason ?? "").not.toContain("没有经过核实");
  } finally {
    await f.close();
  }
}, 120_000);

it("B9：网络抖动转成暂停，不清零活动时长，也不判失败", async () => {
  const { f, kernel, swarm, runId } = await setup();
  try {
    await f.admin.query("update swarm_run set round=2, active_ms=90000 where run_id=$1", [runId]);
    // 直接走挂钩：失败原因是网络类 → 暂停，而不是 failed。
    await swarm.onTurnEnd(f.account, runId, "failed", "MODEL_UPSTREAM_UNAVAILABLE: fetch failed");
    const run = await swarm.run(f.account, runId);
    expect(run.state).toBe("paused");
    expect(run.stateReason ?? "").toContain("模型服务暂时连不上");
    // 活动时长保留（不清零，而且把这一段也算上）。
    expect(run.used.activeMs).toBeGreaterThanOrEqual(90_000);
    expect(run.endReason).toBeUndefined();

    // 真正的逻辑失败仍然判 failed（别把一切都当成网络抖动）。
    await f.admin.query("update swarm_run set state='running' where run_id=$1", [runId]);
    await swarm.onTurnEnd(f.account, runId, "failed", "KERNEL_MAX_TOKENS");
    const failed = await swarm.run(f.account, runId);
    expect(failed.state).toBe("failed");
  } finally {
    await f.close();
  }
}, 120_000);

it("用户点结束时，说明按实际情况写：有已核实就不说「没有经过核实」", async () => {
  const { f, swarm, runId } = await setup();
  try {
    const submitted = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "finish-claim",
      member: "r1-scout",
      claim: { text: "同预算下 agent 数超过 4 之后质量趋于平坦。", basis: "checked_fact" },
      evidence: [evidenceOf("arXiv:2401.00071", "Table 7", "flat after 4")],
    });
    await swarm.reviewResearch(f.account, runId, {
      member: "critic",
      claimId: submitted.claimIds[0],
      kind: "refute",
      verdict: "rejected",
      reason: "试着反驳没找到反例。",
    });
    await swarm.reviewResearch(f.account, runId, {
      member: "verifier",
      claimId: submitted.claimIds[0],
      kind: "verify",
      verdict: "verified",
      reason: "回 Table 7 逐字核对，固定预算那一列确实在 4 之后持平。",
      evidence: [evidenceOf("arXiv:2401.00071", "Table 7", "flat after 4")],
    });
    await swarm.createIntervention(f.account, runId, { kind: "finish" });
    const run = await swarm.run(f.account, runId);
    expect(run.state).toBe("partial");
    expect(run.stateReason ?? "").toContain("已核实 1 条");
    expect(run.stateReason ?? "").not.toContain("没有经过核实");
  } finally {
    await f.close();
  }
}, 120_000);

it("第二批：mention 投递、redirect 出新版本计划、add_member/extend/divergence 四种卡", async () => {
  const { f, swarm, runId } = await setup();
  try {
    // mention：投递到指定队员，回执是 delivered。
    const mention = await swarm.createIntervention(f.account, runId, {
      kind: "mention",
      text: "请把 Table 3 的预算口径说清楚。",
      target: { memberId: "r1-scout" },
    });
    expect(mention.intervention.kind).toBe("mention");
    expect(mention.intervention.state).toBe("delivered");
    expect(mention.intervention.result ?? "").toContain("r1-scout");

    // redirect：改方向之后负责人交新版本计划，直接接着做（不再等确认）。
    const redirect = await swarm.createIntervention(f.account, runId, {
      kind: "redirect",
      text: "只看相同总 token 预算下的比较。",
    });
    expect(redirect.intervention.state).toBe("delivered");
    // 收窄口径（加「同预算」）不算扩大范围：新版本直接用，不出范围卡。
    const narrowed = await swarm.publishPlan(f.account, runId, {
      question: "同预算下多 Agent 数量增加是否一定提高研究质量？",
      scope: "只看同总 token 预算的比较",
      qualityCriteria: ["有对照实验", "同预算"],
      routes: [{ id: "r1", title: "规模曲线", idea: "同预算下的曲线", differsBy: "同预算" }],
      limits: { rounds: 4, minutes: 30 },
    });
    expect(narrowed.version).toBe(2);
    expect((await swarm.run(f.account, runId)).state).toBe("running");
    expect(
      (await f.admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='swarm_scope'",
        [runId],
      )).rows[0].n,
    ).toBe(0);

    // 扩大范围（问题本身变了）：要用户批一次（swarm_scope 卡），状态回到等确认。
    await swarm.createIntervention(f.account, runId, {
      kind: "redirect",
      text: "把范围扩到评测基准与成本结构。",
    });
    const expanded = await swarm.publishPlan(f.account, runId, {
      question:
        "多 Agent 数量增加是否一定提高研究质量？再加一层：2026 年之后的评测基准与成本结构会怎么改变结论？",
      scope: "原问题 + 评测基准与成本结构",
      qualityCriteria: ["有对照实验", "同预算"],
      routes: [{ id: "r1", title: "规模曲线", idea: "同预算下的曲线", differsBy: "同预算" }],
      limits: { rounds: 4, minutes: 30 },
    });
    expect(expanded.version).toBe(3);
    const afterRedirect = await swarm.run(f.account, runId);
    expect(afterRedirect.state).toBe("awaiting_confirm");
    const cards = await f.admin.query(
      "select id, kind, state, effects from approval where run_id=$1 order by created_at",
      [runId],
    );
    const scope = cards.rows.find((row) => row.kind === "swarm_scope");
    expect(scope).toBeTruthy();
    expect((scope!.effects[0] as any).from).toBe(2);
    expect((scope!.effects[0] as any).to).toBe(3);

    // 批准扩大范围：按新计划继续。
    const decided = await swarm.decideCard(f.account, String(scope!.id), { decision: "approve" });
    expect(decided?.state).toBe("approved");

    // 加人：出 swarm_add_member 卡（含 membersAfter / max）。
    const addMember = await swarm.createIntervention(f.account, runId, {
      kind: "add_member",
      role: "researcher",
      target: { routeId: "r1" },
    });
    expect(addMember.intervention.state).toBe("pending_approval");
    const addCard = await f.admin.query(
      "select id, effects from approval where run_id=$1 and kind='swarm_add_member'",
      [runId],
    );
    expect(addCard.rows).toHaveLength(1);
    expect((addCard.rows[0].effects[0] as any).max).toBe(16);
    const approved = await swarm.decideCard(f.account, String(addCard.rows[0].id), {
      decision: "approve",
    });
    expect(approved?.state).toBe("approved");

    // 追加额度：出 swarm_extend 卡（findings / gaps / suggest / used），批准后额度变长。
    const extend = await swarm.createIntervention(f.account, runId, { kind: "extend" });
    expect(extend.intervention.state).toBe("pending_approval");
    const extendCard = await f.admin.query(
      "select id, effects from approval where run_id=$1 and kind='swarm_extend'",
      [runId],
    );
    const payload = extendCard.rows[0].effects[0] as any;
    expect(payload.suggest).toMatchObject({ rounds: 2 });
    expect(payload.used.rounds).toBeGreaterThanOrEqual(0);
    const before = await swarm.run(f.account, runId);
    await swarm.decideCard(f.account, String(extendCard.rows[0].id), {
      decision: "approve",
      answers: { rounds: 3, minutes: 45 },
    });
    const after = await swarm.run(f.account, runId);
    expect(after.limits.rounds).toBe(before.limits.rounds + 3);
    expect(after.limits.minutes).toBe(before.limits.minutes + 45);

    // 连点两次追加额度只留一张待处理卡（卡上的数字会变，按种类去重）。
    await swarm.createIntervention(f.account, runId, { kind: "extend" });
    const countBefore = (
      await f.admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='swarm_extend'",
        [runId],
      )
    ).rows[0].n;
    await swarm.createIntervention(f.account, runId, { kind: "extend" });
    const countAfter = (
      await f.admin.query(
        "select count(*)::int n from approval where run_id=$1 and kind='swarm_extend'",
        [runId],
      )
    ).rows[0].n;
    expect(countAfter).toBe(countBefore);
  } finally {
    await f.close();
  }
}, 120_000);

it("小项：answer 优先具体发现，剩余缺口不混路线合并说明", async () => {
  const { f, swarm, runId } = await setup();
  try {
    // 一条核实员的汇总 + 一条研究员的具体发现，两条都核实通过。
    const summary = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "sum-1",
      member: "verifier",
      claim: { text: "独立核实汇总：本批核了 6 条，其中 3 条属实。", basis: "observation" },
      evidence: [evidenceOf("arXiv:2401.00081", "§1", "summary quote")],
    });
    const finding = await swarm.submitResearch(f.account, runId, {
      kind: "claim",
      submissionId: "find-1",
      member: "r1-scout",
      claim: {
        text: "在固定总预算下，agent 数从 4 加到 8 时准确率不再上升（+0.3pp，落在噪声内）。",
        basis: "checked_fact",
      },
      evidence: [evidenceOf("arXiv:2401.00082", "Table 4", "flat from 4 to 8")],
    });
    // 反驳与核实分人：汇总（verifier 写的）由 r1 反驳、critic 核实；
    // 具体发现（r1 写的）由 critic 反驳、verifier 核实。
    for (const [refuter, claimId] of [
      ["r1-scout", summary.claimIds[0]],
      ["critic", finding.claimIds[0]],
    ] as const) {
      await swarm.reviewResearch(f.account, runId, {
        member: refuter,
        claimId,
        kind: "refute",
        verdict: "rejected",
        reason: "试着反驳没找到反例。",
      });
    }
    for (const [verifier, claimId] of [
      ["critic", summary.claimIds[0]],
      ["verifier", finding.claimIds[0]],
    ] as const) {
      await swarm.reviewResearch(f.account, runId, {
        member: verifier,
        claimId,
        kind: "verify",
        verdict: "verified",
        reason: "回原文核过，数字对得上。",
        evidence: [evidenceOf("arXiv:2401.00082", "Table 4", "flat from 4 to 8")],
      });
    }
    const snapshot = await swarm.snapshot(f.account, runId);
    // 具体发现优先：answer 用的是研究员那条，不是核实员的汇总。
    expect(snapshot.report!.answer).toContain("在固定总预算下");
    expect(snapshot.report!.verified).toHaveLength(2);

    // 合并掉的路线不进剩余缺口。
    await swarm.registerApproach(f.account, runId, {
      title: "规模曲线与成本归一化",
      idea: "把 agent 数量换算到同预算",
      gap: "与 r1 同一条路线，重复登记；已并入 r1，不再单独计一条路线",
    });
    await f.admin.query(
      "update swarm_approach set state='merged' where run_id=$1 and gap like '%重复登记%'",
      [runId],
    );
    const after = await swarm.snapshot(f.account, runId);
    expect(after.report!.gaps.some((gap) => /重复登记|已并入/.test(gap))).toBe(false);
  } finally {
    await f.close();
  }
}, 120_000);

it("B12：负责人忙时插话排队、送到才写已投递、负责人挂了转暂停", async () => {
  const { f, kernel, swarm, runId } = await setup();
  try {
    // 负责人正忙：@队员 与 改方向 都不能另起回合，只能排进收件箱。
    (kernel as any).isLive = () => true;
    const mention = await swarm.createIntervention(f.account, runId, {
      kind: "mention",
      text: "先看同预算这一格。",
      target: { memberId: "r1-scout" },
    });
    expect(mention.intervention.state).toBe("received");
    expect(mention.intervention.result ?? "").toContain("收件箱");

    const redirect = await swarm.createIntervention(f.account, runId, {
      kind: "redirect",
      text: "只看相同总 token 预算下的比较。",
    });
    expect(redirect.intervention.state).toBe("received");

    // 队员与负责人各取自己的：@队员 那条只排在队员名下。
    const forMember = await swarm.pendingFor(f.account, runId, "r1-scout");
    expect(forMember).toHaveLength(1);
    expect(forMember[0].text).toContain("先看同预算这一格");
    const forLead = await swarm.pendingFor(f.account, runId, "lead");
    expect(forLead).toHaveLength(1);
    expect(forLead[0].text).toContain("只看相同总 token 预算");

    // 真送到之后才写「已投递」。
    await swarm.markDelivered(f.account, runId, forMember.map((entry) => entry.id));
    const afterDelivery = await swarm.snapshot(f.account, runId);
    const delivered = afterDelivery.interventions.find((entry) => entry.id === mention.intervention.id)!;
    expect(delivered.state).toBe("delivered");
    expect(delivered.result ?? "").toContain("已送到");

    // 批卡后的指令也一样：负责人忙就排队，回执说清「下一步送到」。
    const addMember = await swarm.createIntervention(f.account, runId, { kind: "add_member" });
    const card = (
      await f.admin.query(
        "select id from approval where run_id=$1 and kind='swarm_add_member' and state='pending'",
        [runId],
      )
    ).rows[0];
    const decided = await swarm.decideCard(f.account, String(card.id), { decision: "approve" });
    expect(decided?.note ?? "").toContain("下一步送到");
    expect((await swarm.pendingFor(f.account, runId, "lead")).length).toBeGreaterThan(0);

    // 真的多出队员之后，加人才算「已执行」。
    await swarm.registerMeta(f.account, runId, {
      kind: "member",
      refId: "extra-01",
      data: { role: "researcher", label: "补招 01", routeId: "r1" },
    });
    const afterJoin = await swarm.snapshot(f.account, runId);
    const addEntry = afterJoin.interventions.find((entry) => entry.id === addMember.intervention.id)!;
    expect(addEntry.state).toBe("applied");
    expect(addEntry.result ?? "").toContain("已建出队员");

    // 负责人的那一轮挂了：群研转暂停并写清原因（不能还显示「运行中」）。
    await f.admin.query("update swarm_run set state='running' where run_id=$1", [runId]);
    await swarm.onLeadTurnFailed(f.account, runId, "failed", "KERNEL_FAILED");
    const paused = await swarm.run(f.account, runId);
    expect(paused.state).toBe("paused");
    expect(paused.stateReason ?? "").toContain("负责人那一轮失败了");
  } finally {
    await f.close();
  }
}, 120_000);
