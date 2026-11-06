import { describe, it, expect } from "vitest";

/**
 * 插件侧的步骤边界投递（B14 next-step）。
 *
 * 插件跑在 DSH 运行时里，`agent.steer(message)` 就是「Submit steering for the
 * nearest step」：控制面只排队，插件在步骤边界取一次并交给这一轮。
 * 这里用假 ctx / 假 agent 把整条路径跑一遍，不依赖真实运行时。
 */
type Steered = { id: string; role: string; source: { kind: string }; text: string };

const loadPlugin = () =>
  import("../../../plugins/reinlab-swarm-plugin/index.js" as string) as Promise<{
    apply: (ctx: any, config: any) => void;
  }>;

function fakeAgent() {
  const steered: Steered[] = [];
  const agent: any = {
    id: "session-1",
    steered,
    steer: (message: any) => {
      steered.push({
        id: message.id,
        role: message.role,
        source: message.source,
        text: message.content.map((block: any) => block.text).join(""),
      });
    },
  };
  const handlers: Record<string, ((...args: any[]) => unknown)[]> = {};
  agent.ctx = {
    tools: {
      register: () => undefined,
      get: () => undefined,
      restrict: () => undefined,
    },
    on: (name: string, handler: (...args: any[]) => unknown) => {
      handlers[name] = [...(handlers[name] ?? []), handler];
    },
    effect: () => () => undefined,
  };
  return { agent, handlers };
}

describe("研究插件：步骤边界投递", () => {
  it("在工具边界取到待送消息，用 agent.steer 交给这一轮，并照实记一条", async () => {
    const plugin = await loadPlugin();
    const { agent, handlers } = fakeAgent();
    const inboxCalls: any[] = [];
    const reports: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (url.endsWith("/kernel/inbox")) {
        inboxCalls.push(body);
        return {
          ok: true,
          json: async () => ({
            messages: [{ id: "m-1", text: "用户批准加人：用 research_spawn 建一名 critic（add_card: card-9）" }],
          }),
        };
      }
      if (url.endsWith("/kernel/tool")) {
        reports.push(body);
        return { ok: true, json: async () => ({ result: { ok: true } }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    };

    let created: ((payload: any) => unknown) | undefined;
    const ctx = {
      tools: { register: () => undefined, restrict: () => undefined, get: () => undefined },
      agents: { list: () => [] as any[], get: () => agent },
      agentTeams: {
        tryMembership: () => ({ role: "lead", name: "lead" }),
        membership: () => ({ role: "lead", name: "lead" }),
        getTask: () => null,
        updateTask: async () => undefined,
        spawnTeammate: async () => ({ id: "x" }),
        createTask: async () => ({ id: "task-1", revision: 1 }),
      },
      systemPrompt: { append: () => undefined },
      on: (name: string, handler: (payload: any) => unknown) => {
        if (name === "agent/created") created = handler;
        return () => undefined;
      },
      effect: (fn: () => unknown) => fn(),
    };

    plugin.apply(ctx, {
      controlUrl: "http://control:3001",
      token: "run-token",
      workspace: "/tmp/reinlab-workspace",
      fetch: fetchImpl,
    });
    // 插件按 agent/created 装载工具与边界钩子。
    expect(created).toBeTypeOf("function");
    await created!({ agent });

    const pre = handlers["tools/pre-execute"];
    expect(pre?.length).toBeGreaterThan(0);
    // 走一次工具边界（装载时注册的那一个）：应当去取待送消息并 steer。
    await pre![0]({ tool: { name: "research_plan" } }, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(inboxCalls).toHaveLength(1);
    expect(inboxCalls[0]).toEqual({ member: "lead" });
    expect(agent.steered).toHaveLength(1);
    expect(agent.steered[0].role).toBe("user");
    expect(agent.steered[0].source).toEqual({ kind: "user-rpc" });
    expect(agent.steered[0].text).toContain("card-9");
    // 回执侧也留了一条：说明这条消息被交给了这一步。
    expect(
      reports.some((body) => String(body?.args?.text ?? "").includes("交给这一轮的下一步")),
    ).toBe(true);
  });
});

describe("研究插件：同一条消息只投一次（B15）", () => {
  it("连续经过多个工具边界，只被 steer 一次", async () => {
    const plugin = await loadPlugin();
    const { agent, handlers } = fakeAgent();
    let inboxHits = 0;
    const fetchImpl = async (url: string, _init: any) => {
      if (url.endsWith("/kernel/inbox")) {
        inboxHits += 1;
        // 控制面「取即领走」：第一次给这条，之后给空（这正是修复后的行为）。
        return {
          ok: true,
          json: async () =>
            inboxHits === 1
              ? { messages: [{ id: "m-dup", text: "用户批准加人：建一名 critic（add_card: card-1）" }] }
              : { messages: [] },
        };
      }
      return { ok: true, json: async () => ({ result: { ok: true } }) };
    };
    let created: ((payload: any) => unknown) | undefined;
    plugin.apply(
      {
        tools: { register: () => undefined, restrict: () => undefined, get: () => undefined },
        agents: { list: () => [] as any[], get: () => agent },
        agentTeams: {
          tryMembership: () => ({ role: "lead", name: "lead" }),
          membership: () => ({ role: "lead", name: "lead" }),
          getTask: () => null,
          updateTask: async () => undefined,
          spawnTeammate: async () => ({ id: "x" }),
          createTask: async () => ({ id: "task-1", revision: 1 }),
        },
        systemPrompt: { append: () => undefined },
        on: (name: string, handler: (payload: any) => unknown) => {
          if (name === "agent/created") created = handler;
          return () => undefined;
        },
        effect: (fn: () => unknown) => fn(),
      },
      { controlUrl: "http://control:3001", token: "run-token", workspace: "/tmp/ws", fetch: fetchImpl },
    );
    await created!({ agent });
    const pre = handlers["tools/pre-execute"]![0];

    // 连续五次工具边界（节流窗口内，等一会儿再走一次，确保每次都真的去取）。
    for (let i = 0; i < 5; i += 1) {
      await pre({ tool: { name: "research_plan" } }, async () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
    // 即使控制面重复给同一条，插件侧也按 id 去重：只 steer 一次。
    expect(agent.steered).toHaveLength(1);
    expect(agent.steered[0].text).toContain("card-1");
  }, 30_000);
});

describe("研究插件：工具面（17 返工）", () => {
  it("队员拿到 bash / read / grep 这些通用工具，只有 present 仍归负责人", async () => {
    const plugin = await loadPlugin();
    const denied: string[][] = [];
    const agent: any = { id: "session-2" };
    agent.ctx = {
      tools: {
        register: () => undefined,
        get: (name: string) => ({ name }),
        restrict: (options: { deny?: string[] }) => {
          if (options?.deny) denied.push(options.deny);
        },
      },
      on: () => () => undefined,
      effect: () => () => undefined,
    };
    let created: ((payload: any) => unknown) | undefined;
    plugin.apply(
      {
        tools: { register: () => undefined, restrict: () => undefined, get: () => undefined },
        agents: { list: () => [] as any[], get: () => agent },
        agentTeams: {
          tryMembership: () => ({ role: "researcher", name: "r1-scout" }),
          membership: () => ({ role: "researcher", name: "r1-scout" }),
          getTask: () => null,
          updateTask: async () => undefined,
          spawnTeammate: async () => ({ id: "x" }),
          createTask: async () => ({ id: "task-1", revision: 1 }),
        },
        systemPrompt: { append: () => undefined },
        on: (name: string, handler: (payload: any) => unknown) => {
          if (name === "agent/created") created = handler;
          return () => undefined;
        },
        effect: (fn: () => unknown) => fn(),
      },
      {
        controlUrl: "http://control:3001",
        token: "run-token",
        workspace: "/tmp/reinlab-ws-rework",
        fetch: async () => ({ ok: true, json: async () => ({ result: { ok: true } }) }),
      },
    );
    await created!({ agent });
    const flat = denied.flat();
    // 通用工具不再被收窄：bash / read / grep 都不能出现在 deny 里。
    expect(flat).not.toContain("bash");
    expect(flat).not.toContain("read");
    expect(flat).not.toContain("grep");
    // 交付出口仍只给负责人。
    expect(flat).toContain("present");
  });
});

describe("研究插件：成稿工具（B1）", () => {
  it("负责人能注册到 research_narrative，队员拿不到", async () => {
    const plugin = await loadPlugin();
    const leadTools: string[] = [];
    const teammateTools: string[] = [];
    let created: ((payload: any) => unknown) | undefined;
    const ctx = (bucket: string[]) => ({
      tools: {
        register: (definition: { name: string }) => {
          bucket.push(definition.name);
        },
        get: () => undefined,
        restrict: () => undefined,
      },
      on: () => () => undefined,
      effect: (fn: () => unknown) => fn(),
    });
    const leadAgent: any = { id: "session-lead", ctx: ctx(leadTools) };
    const teammateAgent: any = { id: "session-mate", ctx: ctx(teammateTools) };
    plugin.apply(
      {
        tools: { register: () => undefined, restrict: () => undefined, get: () => undefined },
        agents: { list: () => [leadAgent, teammateAgent] as any[], get: (id: string) => (id === "session-lead" ? leadAgent : teammateAgent) },
        agentTeams: {
          tryMembership: (agent: any) =>
            agent.id === "session-lead"
              ? { role: "lead", name: "lead" }
              : { role: "researcher", name: "r1-scout" },
          membership: (agent: any) =>
            agent.id === "session-lead"
              ? { role: "lead", name: "lead" }
              : { role: "researcher", name: "r1-scout" },
          getTask: () => null,
          updateTask: async () => undefined,
          spawnTeammate: async () => ({ id: "x" }),
          createTask: async () => ({ id: "task-1", revision: 1 }),
        },
        systemPrompt: { append: () => undefined },
        on: (name: string, handler: (payload: any) => unknown) => {
          if (name === "agent/created") created = handler;
          return () => undefined;
        },
        effect: (fn: () => unknown) => fn(),
      },
      {
        controlUrl: "http://control:3001",
        token: "run-token",
        workspace: "/tmp/reinlab-ws-narrative",
        fetch: async () => ({ ok: true, json: async () => ({ result: { ok: true } }) }),
      },
    );
    await created!({ agent: leadAgent });
    await created!({ agent: teammateAgent });
    expect(leadTools).toContain("research_narrative");
    expect(teammateTools).not.toContain("research_narrative");
  });
});
