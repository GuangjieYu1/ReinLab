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
