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
