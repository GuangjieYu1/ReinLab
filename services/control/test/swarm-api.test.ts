import { it, expect } from "vitest";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelFixture } from "./kernel-fixture";
import { createApp } from "../src/api/app";
import { KernelAuth } from "../src/kernel/auth";
import { KernelService } from "../src/kernel/service";
import { SwarmService } from "../src/swarm/service";
import type { HarnessFactory } from "../src/kernel/dsh/session";

const HOME = mkdtempSync(join(tmpdir(), "swarm-runs-"));

/**
 * 一轮里就演一次真实的团队：建队、建任务、认领、交付、发消息。
 * 事件形状照 DSH 0.2.1-rc.4 的 team/member、team/task、tool/call、tool/result，
 * 让折算逻辑走和真实运行同一条路。
 */
function teamTurn(): HarnessFactory {
  const lead = "ds-lead";
  const researcher = "ds-researcher";
  // 一轮里按真实顺序发生的事：建队 → 建任务 → 领取 → 发消息 → 交付。
  const events: { type: string; data?: Record<string, unknown>; session?: string }[] = [
    {
      type: "team/member",
      data: {
        teamId: lead,
        version: 2,
        member: {
          id: researcher,
          name: "researcher-01",
          description: "负责路线 r1",
          provider: "spawn",
          context: "fresh",
          phase: "active",
        },
      },
    },
    {
      type: "tool/call",
      data: {
        name: "team_task_create",
        callId: "call-1",
        arguments: JSON.stringify({ subject: "r1 实证", description: "route=r1 kind=research" }),
      },
    },
    {
      type: "tool/result",
      data: {
        step: 1,
        turn: 1,
        message: {
          toolCallId: "call-1",
          isError: false,
          content: [
            { type: "text", text: JSON.stringify({ id: "task-1", revision: 1, status: "pending" }) },
          ],
        },
      },
    },
    {
      type: "team/task",
      data: {
        teamId: lead,
        version: 2,
        task: {
          id: "task-1",
          revision: 2,
          subject: "r1 实证",
          description: "route=r1 kind=research",
          status: "in_progress",
          ownerId: researcher,
          blockedBy: [],
          writeScopes: [],
        },
      },
    },
    {
      type: "tool/call",
      data: {
        name: "send_message",
        callId: "call-2",
        arguments: JSON.stringify({
          target: "researcher-01",
          message: "先从总预算相同的比较开始",
        }),
      },
    },
    {
      type: "tool/result",
      data: {
        step: 2,
        turn: 1,
        message: {
          toolCallId: "call-2",
          isError: false,
          content: [{ type: "text", text: JSON.stringify({ sent: true }) }],
        },
      },
    },
    {
      type: "user/message",
      session: researcher,
      data: {
        source: { form: "relay", kind: "agent-message", senderSessionId: researcher },
        content: [{ type: "text", text: "Team message from researcher-01:" }, { type: "text", text: "r1 先交一版" }],
      },
    },
    {
      type: "user/message",
      session: lead,
      data: {
        source: { form: "relay", kind: "agent-message", senderSessionId: researcher },
        content: [{ type: "text", text: "Team message from researcher-01:" }, { type: "text", text: "r1 先交一版" }],
      },
    },
    {
      type: "user/message",
      session: researcher,
      data: {
        source: { kind: "user" },
        content: [{ type: "text", text: "你是这次群研的研究员 01，跟路线 r1。共享任务 id 是 task-1。" }],
      },
    },
    {
      type: "team/task",
      data: {
        teamId: lead,
        version: 2,
        task: {
          id: "task-1",
          revision: 3,
          subject: "r1 实证",
          description: "route=r1 kind=research",
          status: "completed",
          ownerId: researcher,
          blockedBy: [],
          writeScopes: [],
        },
      },
    },
  ];
  // 第一轮是澄清：不建队、不建任务；确认之后的那一轮才真的开跑。
  let turns = 0;
  const execute = async (sessionId: string, options: any) => {
    turns += 1;
    // 澄清那一轮不建队，建队只发生在确认后的那一轮；再往后（如果有）不再重放，
    // 否则同一批事件会重复进库，页面上就会重复。
    for (const event of turns === 2 ? events : [])
      options?.onNotification?.({
        method: "session.event",
        params: { event: { type: event.type, data: event.data }, sessionId: event.session ?? lead },
      });
    return {
      sessionId,
      events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
      finalResponse: "done",
    };
  };
  return () => ({
    session: (id: string) => ({ run: (prompt: unknown, options: any) => execute(id, options) }),
    resumeSession: async () => ({ run: (prompt: unknown, options: any) => execute(lead, options) }),
    close: async () => {},
  });
}

const io = {
  mkdir: async (path: string) => void (await mkdir(path, { recursive: true, mode: 0o700 })),
  write: async (file: string, body: string) => void (await writeFile(file, body, { mode: 0o600 })),
  remove: async (file: string) => void (await rm(file, { force: true })),
};

/** 读一小段 SSE 帧就收手：流是长连接，不能等它自己关。 */
async function readStream(
  request: (path: string) => Promise<Response>,
  path: string,
  ms: number,
): Promise<{ type: string; data: unknown }[]> {
  const response = await request(path);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { type: string; data: unknown }[] = [];
  let buffer = "";
  const deadline = Date.now() + ms;
  let finished = false;
  while (!finished && Date.now() < deadline) {
    // 服务端每 500ms 推一拍；单拍超时只说明这拍没数据，不算流结束。
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 260)),
    ]);
    if (!chunk) continue;
    if (chunk.done) finished = true;
    if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const cut = buffer.indexOf("\n\n");
      if (cut < 0) break;
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (!frame.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(frame.slice(6)) as { type: string; data: unknown });
      } catch {
        /* 不完整的一帧，忽略 */
      }
    }
  }
  await reader.cancel().catch(() => undefined);
  return events;
}

it("群研：发起 → 计划 → 确认 → 名册/任务/通信/留言/干预，费用未知不记 0", async () => {
  const f = await kernelFixture();
  try {
    const issuer = "https://swarm.fixture/auth/v1";
    const kernel = new KernelService({
      db: f.db,
      auth: new KernelAuth(generateKeyPairSync("ed25519").privateKey),
      factory: teamTurn(),
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
    const app = await createApp({ pool: f.pool, auth: { issuer, secret: randomBytes(48) }, kernel, swarm });
    const cookie = await f.sessionCookie();
    const request = (path: string, body?: unknown, key = crypto.randomUUID()) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: new URL(path, "http://localhost").origin,
          "X-ReinLab-CSRF": "1",
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    // 发起：进入 clarifying，不建队。
    const started = await request("/v1/kernel/runs", { dossierId: f.dossier, mode: "swarm", query: "多 Agent 数量增加是否一定提高研究质量？" });
    expect(started.status).toBe(201);
    const { id: runId } = (await started.json()) as { id: string };
    const firstSnapshot = await request(`/v1/swarm/runs/${runId}`);
    let snapshot: any = await firstSnapshot.json();
    if (!snapshot.run) throw new Error("snapshot=" + JSON.stringify(snapshot));
    expect(snapshot.run.state).toBe("clarifying");
    expect(snapshot.plan).toBeNull();
    // 开跑前名册里就有负责人这一行（E5）：DSH 不给负责人成员事件，按负责人会话补。
    expect(snapshot.members).toHaveLength(1);
    expect(snapshot.members[0]).toMatchObject({ id: "lead", role: "lead", label: "负责人" });
    // 还没花过钱：未知就是未知，不是 0。
    expect(snapshot.run.used.cost).toEqual({ value: null, known: false });
    expect(snapshot.run.used.tokens).toBeNull();

    // 同一档案上重复发起：还是同一个运行，不新开。
    const again = await request("/v1/kernel/runs", { dossierId: f.dossier, mode: "swarm", query: "再看一次" });
    expect(((await again.json()) as any).id).toBe(runId);
    const list = (await (await request(`/v1/swarm/dossiers/${f.dossier}/runs`)).json()) as any;
    expect(list.runs).toHaveLength(1);

    // 负责人交计划：入库、等确认。
    await swarm.publishPlan(f.account, runId, {
      question: "多 Agent 数量增加是否一定提高研究质量？",
      scope: "只看有对照实验的研究",
      qualityCriteria: ["有可复现的对照", "说明适用范围"],
      routes: [
        { id: "r1", title: "数量与质量的实证", idea: "按 N 做对照", differsBy: "只看数字" },
        { id: "r2", title: "协作机制与同质化", idea: "看机制", differsBy: "不看数字" },
        { id: "r3", title: "评价方法与反例", idea: "看评测", differsBy: "看反例" },
      ],
      limits: { rounds: 4, minutes: 30 },
    });
    snapshot = await (await request(`/v1/swarm/runs/${runId}`)).json();
    expect(snapshot.run.state).toBe("awaiting_confirm");
    expect(snapshot.plan.version).toBe(1);
    expect(snapshot.plan.roster.map((entry: any) => [entry.role, entry.count])).toEqual([
      ["lead", 1],
      ["researcher", 3],
      ["critic", 1],
      ["verifier", 1],
    ]);
    expect(snapshot.routes.map((route: any) => route.id)).toEqual(["r1", "r2", "r3"]);

    // 版本不符：409 PLAN_STALE 并带最新版本。
    const stale = await request(`/v1/swarm/runs/${runId}/plan/confirm`, { planVersion: 99 });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as any).code).toBe("PLAN_STALE");

    // 低于下限的额度直接拒绝。
    const tooLow = await request(`/v1/swarm/runs/${runId}/plan/confirm`, { planVersion: 1, limits: { rounds: 2 } });
    expect(tooLow.status).toBe(400);
    expect(((await tooLow.json()) as any).code).toBe("LIMIT_TOO_LOW");

    // 确认开跑：进入 running，第 1 轮。
    const confirmed = await request(`/v1/swarm/runs/${runId}/plan/confirm`, { planVersion: 1 });
    expect(confirmed.status).toBe(200);

    // 全体成员、任务、通信都由 DSH 事件折算出来。
    for (let i = 0; i < 60; i += 1) {
      snapshot = await (await request(`/v1/swarm/runs/${runId}`)).json();
      if (snapshot.members.length > 0 && snapshot.tasks.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 名册：负责人 1 + 研究员 1（这一轮只建了一个）。
    expect(snapshot.members).toHaveLength(2);
    expect(snapshot.members.find((member: any) => member.role === "lead")).toMatchObject({
      id: "lead",
      label: "负责人",
      sessionId: "ds-lead",
    });
    expect(snapshot.members.find((member: any) => member.role === "researcher")).toMatchObject({
      id: "researcher-01",
      role: "researcher",
      label: "研究员 01",
      context: "fresh",
      sessionId: "ds-researcher",
    });
    expect(snapshot.tasks[0]).toMatchObject({ id: "task-1", routeId: "r1", kind: "research", owner: "researcher-01" });
    // 累计创建的队员数（不含负责人）。
    expect(snapshot.run.members.used).toBe(1);
    expect(snapshot.run.members.max).toBe(16);

    // 通信条目是这一批里最后几条：等它落库再断言，别拿半截快照当全部。
    let timeline: any = { entries: [] };
    for (let i = 0; i < 60; i += 1) {
      timeline = await (await request(`/v1/swarm/runs/${runId}/timeline?after=0`)).json();
      if ((timeline.entries ?? []).some((entry: any) => entry.text === "r1 先交一版")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const kinds = timeline.entries.map((entry: any) => entry.type);
    expect(kinds).toContain("message");
    expect(kinds).toContain("broadcast");
    const message = timeline.entries.find((entry: any) => entry.type === "message");
    expect(message).toMatchObject({ from: "lead", to: "researcher-01", delivery: "sent" });
    // 通信条目的 seq 是全局事件序号（实时流和分页时间线必须对得上）。
    expect(message.seq).toBeGreaterThan(0);

    // 队员记录：负责人的工具调用也进同一条记录（点开负责人看得到真实工作记录）。
    const leadLog = (await (await request(`/v1/swarm/runs/${runId}/members/lead/log?after=0`)).json()) as any;
    expect(leadLog.items.length).toBeGreaterThan(0);
    const leadTools = leadLog.items.filter((item: any) => item.kind === "tool");
    expect(leadTools.length).toBeGreaterThan(0);
    expect(leadTools[0].tool.name).toEqual(expect.any(String));
    expect(leadTools[0].seq).toBeGreaterThan(0);
    // 每条都带 at（E4）。
    expect(leadLog.items.every((item: any) => typeof item.at === "string")).toBe(true);

    // 队内消息：发送者会话里那份副本不再记一遍（E3），收件人是真正收到的人。
    const teammateMessages = timeline.entries.filter(
      (entry: any) => entry.type === "message" && entry.text === "r1 先交一版",
    );
    expect(teammateMessages).toHaveLength(1);
    expect(teammateMessages[0]).toMatchObject({ from: "researcher-01", to: "lead", delivery: "received" });
    // 建队提示词不是用户说的话，不进通信面。
    expect(
      timeline.entries.some((entry: any) => /^你是这次群研的/.test(entry.text ?? "")),
    ).toBe(false);

    // 留言：用户发言进留言板；@队员 同时生成 mention 干预。
    const posted = await request(`/v1/swarm/runs/${runId}/posts`, {
      col: "question",
      text: "@researcher-01 只看相同总 token 预算下的比较",
    });
    expect(posted.status).toBe(201);
    const post = (await posted.json()) as any;
    expect(post.by).toBe("user");
    expect(post.col).toBe("question");
    // @队员 同时生成一条 mention 干预：从快照里读回，回执和留言分开。
    const afterPost = await (await request(`/v1/swarm/runs/${runId}`)).json();
    const mention = afterPost.interventions.find((entry: any) => entry.kind === "mention");
    expect(mention).toMatchObject({ state: "received" });
    expect(mention.target.memberId).toBe("researcher-01");

    // 暂停：状态与计时都停住。
    const paused = await request(`/v1/swarm/runs/${runId}/interventions`, { kind: "pause" });
    expect(paused.status).toBe(201);
    expect(((await paused.json()) as any).kind).toBe("pause");
    snapshot = await (await request(`/v1/swarm/runs/${runId}`)).json();
    expect(snapshot.run.state).toBe("paused");
    // 干预变成 applied 也要推事件（E1），页面不刷新就能看到「已执行」。
    const states = await readStream(request, `/v1/swarm/runs/${runId}/stream?after=0`, 1500);
    expect(
      states
        .filter((event) => event.type === "intervention")
        .map((event) => (event.data as { state?: string }).state),
    ).toContain("applied");
    const frozen = snapshot.run.used.activeMs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    snapshot = await (await request(`/v1/swarm/runs/${runId}`)).json();
    expect(snapshot.run.used.activeMs).toBe(frozen);

    // 继续 → 结束：结束要说「部分完成」，不伪装成功。
    const resumed = await request(`/v1/swarm/runs/${runId}/interventions`, { kind: "resume" });
    expect(resumed.status).toBe(201);
    const finished = await request(`/v1/swarm/runs/${runId}/interventions`, { kind: "finish" });
    expect(finished.status).toBe(201);
    snapshot = await (await request(`/v1/swarm/runs/${runId}`)).json();
    expect(snapshot.run.state).toBe("partial");
    expect(snapshot.run.endReason).toBe("user_finished");
    expect(snapshot.run.stateReason).toContain("没有经过核实");

    // 靠后阶段的干预现在明确拒绝，而不是假装做掉。
    const unsupported = await request(`/v1/swarm/runs/${runId}/interventions`, { kind: "add_member" });
    expect(unsupported.status).toBe(409);
    expect(((await unsupported.json()) as any).code).toBe("INTERVENTION_UNSUPPORTED");


  } finally {
    await f.close();
  }
}, 120_000);

/**
 * B1 回归：确认计划时如果负责人还在上一回合里，那一回合结束不能把刚开跑的运行
 * 判成「任务都交付了」（当时 0 个任务），「用户已确认计划」也只能进一遍。
 */
it("群研：0 个任务不算答完，开跑指令只发一次", async () => {
  const f = await kernelFixture();
  try {
    const issuer = "https://swarm-b1.fixture/auth/v1";
    // 这一档的两回合都不建队：用来验证「没有任务就不许判完成」。
    const silent: HarnessFactory = () => ({
      session: (id: string) => ({
        run: async () => ({
          sessionId: id,
          events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
          finalResponse: "",
        }),
      }),
      resumeSession: async () => ({
        run: async () => ({
          sessionId: "ds-silent",
          events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
          finalResponse: "",
        }),
      }),
      close: async () => {},
    });
    const kernel = new KernelService({
      db: f.db,
      auth: new KernelAuth(generateKeyPairSync("ed25519").privateKey),
      factory: silent,
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
    // 数一数开跑指令发了几遍：验收里同一句进了两遍。
    const prompts: string[] = [];
    const realSubmit = kernel.submit.bind(kernel);
    kernel.submit = (async (account: string, run: string, options: any = {}) => {
      if (typeof options.prompt === "string") prompts.push(options.prompt);
      return realSubmit(account, run, options);
    }) as typeof kernel.submit;
    const swarm = new SwarmService({ db: f.db, kernel, model: "deepseek-v4-flash" });
    kernel.attachSwarm(swarm);
    const app = await createApp({ pool: f.pool, auth: { issuer, secret: crypto.randomUUID() }, kernel, swarm });
    const cookie = await f.sessionCookie();
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Cookie: cookie,
          Origin: new URL(path, "http://localhost").origin,
          "X-ReinLab-CSRF": "1",
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const started = await request("/v1/kernel/runs", {
      dossierId: f.dossier,
      mode: "swarm",
      query: "多 Agent 数量增加是否一定提高研究质量？",
    });
    const { id: runId } = (await started.json()) as { id: string };
    await swarm.publishPlan(f.account, runId, {
      question: "多 Agent 数量增加是否一定提高研究质量？",
      scope: "只查 LLM 多智能体",
      qualityCriteria: ["有对照"],
      routes: [{ id: "r1", title: "实证", idea: "对照", differsBy: "看数字" }],
      limits: { rounds: 4, minutes: 30 },
    });
    const confirmed = await request(`/v1/swarm/runs/${runId}/plan/confirm`, { planVersion: 1 });
    expect(confirmed.status).toBe(200);

    // 上一回合结束：不能判成答完（0 任务 / 0 交付）。
    // 先等这一轮真的收尾（同一运行不允许两个回合并发，守卫会直接跳过）。
    const quiesce = async () => {
      for (let i = 0; i < 100 && kernel.liveTurns(runId) > 0; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await quiesce();
    await swarm.onTurnEnd(f.account, runId, "completed");
    let snapshot = (await (await request(`/v1/swarm/runs/${runId}`)).json()) as any;
    expect(snapshot.run.state).not.toBe("partial");
    expect(snapshot.run.stateReason ?? "").not.toContain("任务都交付了");

    // 再结束几回合也不该答完，轮次按额度往上走、到限才收尾。
    for (let i = 0; i < 4; i += 1) {
      await quiesce();
      await swarm.onTurnEnd(f.account, runId, "completed");
    }
    snapshot = (await (await request(`/v1/swarm/runs/${runId}`)).json()) as any;
    expect(snapshot.run.state).toBe("partial");
    expect(snapshot.run.endReason).toBe("limit");
    expect(snapshot.run.stateReason).toContain("没有建出任何任务");

    // 开跑指令只发一遍。
    expect(prompts.filter((prompt) => prompt.includes("用户已确认计划")).length).toBe(1);
  } finally {
    await f.close();
  }
}, 120_000);
