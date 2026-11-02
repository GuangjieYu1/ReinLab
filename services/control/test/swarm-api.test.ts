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
  const events: { type: string; data?: Record<string, unknown> }[] = [
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
    for (const event of turns === 1 ? [] : events)
      options?.onNotification?.({ method: "session.event", params: { event } });
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
    expect(snapshot.members).toEqual([]);
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

    const timeline = (await (await request(`/v1/swarm/runs/${runId}/timeline?after=0`)).json()) as any;
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
    expect(leadLog.items[0]).toMatchObject({ kind: "tool", tool: { name: expect.any(String) } });
    expect(leadLog.items[0].seq).toBeGreaterThan(0);

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
