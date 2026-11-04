// ReinLab「群研」的研究工具与隔离（design/prd/12-swarm.md §5、13-swarm-contract.md §2）。
//
// 这个插件跑在 DSH 内核里，和官方团队插件（@deepseek-ai/dsh-experimental-tool-agent-team）
// 同一层。它只做两件事：
//   1) 负责人交计划、查状态：转给控制面，计划要等用户确认才开跑；
//   2) 队员的工具边界：研究员/反驳/核实的会话里，把能碰全盘的 bash、通用文件读写、
//      grep、skill 这些从这一层的可见工具里去掉，只留读网页和研究目录里的读写。
//      DSH 的 writeScopes 只是冲突提示，不是权限隔离，所以边界必须在这里做。
//
// 工具定义是手写的 JSON Schema 规格（不依赖 @deepseek-ai/dsh-tools），
// 这样宿主模式和容器里都能直接从插件文件跑起来。
import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export const name = "reinlab-swarm";
// 这一档只在群研运行里挂：四个服务在 sdk profile 里都有。
export const inject = ["tools", "agents", "agentTeams", "systemPrompt"];

/** 队员会话里不该再拿到的通用工具（能绕过子目录边界的那批）。 */
const DENIED_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "read_image",
  "glob",
  "grep",
  "job_kill",
  "job_list",
  "job_output",
  "skill",
  "present",
  "todo_write",
  "ask_user_question",
];

const MAX_FILE_BYTES = 256 * 1024;

function required(config, key) {
  const value = config && config[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`reinlab-swarm-plugin: missing config ${key}`);
  return value;
}

async function readToken(config) {
  if (typeof config.token === "string" && config.token.trim() !== "")
    return config.token.trim();
  const text = await readFile(required(config, "tokenFile"), "utf8");
  const token = text.trim();
  if (!token) throw new Error("reinlab-swarm-plugin: empty run token");
  return token;
}

/** 控制面客户端：和精读插件同一个入口，令牌只在运行目录的只读文件里。 */
export function createClient(config, fetchImpl = fetch) {
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  /**
   * 通用控制面调用（不经过工具入口）：取待送的用户消息时用。
   * 令牌和工具调用一样，只在运行目录的只读文件里。
   */
  async function post(path, body) {
    const token = await readToken(config);
    const response = await fetchImpl(`${controlUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) return { error: { code: `CONTROL_${response.status}` } };
    return { result: await response.json().catch(() => ({})) };
  }
  const call = async function call(server, tool, args) {
    const token = await readToken(config);
    const response = await fetchImpl(`${controlUrl}/kernel/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ server, tool, args }),
      signal: AbortSignal.timeout(Number(config.toolTimeoutMs ?? 60_000)),
    }).catch((error) => ({
      ok: false,
      status: 0,
      json: async () => ({
        code:
          error?.name === "TimeoutError" ? "KERNEL_TOOL_TIMEOUT" : "KERNEL_TOOL_UNREACHABLE",
        message: "这次工具调用没有拿到控制面的响应。",
      }),
    }));
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      return {
        error: {
          code: String(body.code ?? `KERNEL_TOOL_HTTP_${response.status}`),
          message: String(body.message ?? `工具返回 ${response.status}`),
        },
      };
    return { result: body.result };
  };
  // 取待送消息走同一个客户端（同一个令牌、同一个控制面地址）。
  call.post = post;
  return call;
}

// ── 手写工具规格（参数对象 → JSON Schema）──────────────
function fieldSchema(spec) {
  const schema = {};
  if (spec.type) schema.type = spec.type;
  if (spec.description) schema.description = spec.description;
  if (Array.isArray(spec.enum)) schema.enum = spec.enum;
  if (spec.items) schema.items = fieldSchema(spec.items);
  if (spec.type === "array" && !schema.items) schema.items = {};
  if (spec.type === "object" && spec.properties) {
    const nested = { type: "object", properties: {}, additionalProperties: false };
    const requiredNested = [];
    for (const [key, child] of Object.entries(spec.properties)) {
      nested.properties[key] = fieldSchema(child);
      if (child.required) requiredNested.push(key);
    }
    if (requiredNested.length) nested.required = requiredNested;
    schema.properties = nested.properties;
    if (nested.required) schema.required = nested.required;
    schema.additionalProperties = false;
  }
  return schema;
}

function defineTool(options) {
  const properties = {};
  const requiredKeys = [];
  for (const [key, spec] of Object.entries(options.parameters ?? {})) {
    properties[key] = fieldSchema(spec);
    if (spec && spec.required) requiredKeys.push(key);
  }
  const parameters = {
    type: "object",
    properties,
    additionalProperties: false,
    ...(requiredKeys.length ? { required: requiredKeys } : {}),
  };
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: { type: "object", additionalProperties: true },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    execute: options.execute,
  };
}

// ── 子目录边界 ────────────────────────────────────
/**
 * 把 `rel` 限死在自己的目录里：相对路径按目录解析，`..`、绝对路径、以及
 * 指向外面的符号链接一律拒绝。写完/读之前都按真实路径再核一次。
 */
export async function resolveInside(root, rel) {
  const base = await realpath(root).catch(() => resolve(root));
  if (typeof rel !== "string" || rel.trim() === "") throw new Error("PATH_REQUIRED");
  if (rel.startsWith("/") || rel.includes("\0")) throw new Error("PATH_OUTSIDE_SCOPE");
  const target = resolve(base, rel);
  if (target !== base && !target.startsWith(base + sep)) throw new Error("PATH_OUTSIDE_SCOPE");
  if (target === base) return { base, target };
  // 已经存在的路径按真实路径核；新文件/新子目录就往上找到最近一个已存在的祖先，
  // 核完边界再由调用方建目录——队员第一次写 team/<名字>/notes.md 时目录还没建过，
  // 这里不能因此报 PATH_NOT_FOUND（真实验收里三名研究员都被卡在这一步）。
  const existing = await realpath(target).catch(() => null);
  if (existing) {
    if (existing !== base && !existing.startsWith(base + sep)) throw new Error("PATH_OUTSIDE_SCOPE");
    return { base, target: existing };
  }
  let probe = dirname(target);
  for (;;) {
    const real = await realpath(probe).catch(() => null);
    if (real) {
      if (real !== base && !real.startsWith(base + sep)) throw new Error("PATH_OUTSIDE_SCOPE");
      break;
    }
    if (probe === base || probe === dirname(probe)) break;
    probe = dirname(probe);
  }
  return { base, target };
}

/** 队员名 → 角色（控制面也有一份同样的判断，这里只为决定读的边界）。 */
function memberRoleOf(name, role) {
  if (role === "critic" || role === "verifier") return role;
  if (/critic|refut|review|反驳/i.test(name)) return "critic";
  if (/verif|check|核实/i.test(name)) return "verifier";
  return "researcher";
}

const clamp = (value, max = 400) =>
  typeof value === "string" ? (value.length > max ? value.slice(0, max) + "…" : value) : value;

/**
 * 插件入口。两类作用域分别装：
 *   - 负责人：交计划、查状态；
 *   - 队员：受限目录读写 + 把通用工具收窄。
 */
export function apply(ctx, config) {
  const call = createClient(config, (config && config.fetch) || fetch);
  const workspace = required(config, "workspace");
  const teamRoot = join(workspace, "team");
  const installed = new Map();

  const report = async (member, item) => {
    await call("swarm", "log", { ...item, member }).catch(() => undefined);
  };

  const installLead = (agent, scoped) => {
    const register = (definition) => scoped.tools.register(definition);
    register(
      defineTool({
        name: "research_plan",
        description:
          "把这次群研的计划交给用户确认：研究问题、边界、质量判据、几条不同路线、编制、轮数/时长。交上来之后会停下来等用户确认，不要当成已经开跑。",
        parameters: {
          question: { type: "string", required: true, description: "一句话说清要研究的问题。" },
          scope: { type: "string", description: "边界：包含什么、不包含什么。" },
          quality_criteria: {
            type: "array",
            items: { type: "string" },
            description: "怎么判断答得好，3 条以内。",
          },
          routes: {
            type: "array",
            required: true,
            description: "不同路线：同义改写不算新路线。3 条左右。",
            items: {
              type: "object",
              properties: {
                id: { type: "string", required: true, description: "短 id，如 r1。" },
                title: { type: "string", required: true },
                idea: { type: "string", required: true, description: "这条路线打算怎么做。" },
                differs_by: { type: "string", required: true, description: "和别的路线差在哪。" },
              },
            },
          },
          roster: {
            type: "array",
            description: "编制；不写就用默认的负责人 1、研究员 3、反驳 1、核实 1。",
            items: {
              type: "object",
              properties: {
                role: {
                  type: "string",
                  required: true,
                  enum: ["lead", "researcher", "critic", "verifier"],
                },
                count: { type: "integer", required: true },
                model: { type: "string" },
                route_ids: { type: "array", items: { type: "string" } },
              },
            },
          },
          rounds: { type: "integer", description: "轮数，最少 4。" },
          minutes: { type: "integer", description: "时长（分钟），最少 30。" },
        },
        timeoutMs: 30_000,
        async execute(args) {
          const outcome = await call("swarm", "plan", {
            question: args.question,
            scope: args.scope ?? "",
            qualityCriteria: args.quality_criteria ?? [],
            routes: (args.routes ?? []).map((route) => ({
              id: route.id,
              title: route.title,
              idea: route.idea,
              differsBy: route.differs_by ?? "",
            })),
            roster: (args.roster ?? []).map((entry) => ({
              role: entry.role,
              count: entry.count,
              model: entry.model ?? "",
              ...(entry.route_ids ? { routeIds: entry.route_ids } : {}),
            })),
            limits: {
              ...(args.rounds ? { rounds: args.rounds } : {}),
              ...(args.minutes ? { minutes: args.minutes } : {}),
            },
          });
          if (outcome.error) return outcome.error;
          return {
            submitted: true,
            version: outcome.result?.version ?? null,
            message: "计划已经交给用户确认；确认之后才会开跑。",
          };
        },
      }),
    );
    register(
      defineTool({
        name: "research_spawn",
        description:
          "建一名队员并登记他的研究身份：角色（researcher / critic / verifier）、跟哪条路线、显示名。研究员一律全新上下文（fresh）。建人只走这个工具，不要再直接调 spawn_teammate，否则路线和角色对不上。",
        parameters: {
          name: { type: "string", required: true, description: "唯一的小写名字，如 r1-scaling。" },
          role: {
            type: "string",
            required: true,
            enum: ["researcher", "critic", "verifier"],
          },
          route_id: { type: "string", description: "跟的路线 id（研究员必填；反驳/核实可留空）。" },
          label: { type: "string", description: "页面上显示的名字，如「研究员 01」。可留空。" },
          description: { type: "string", required: true, description: "这名队员负责什么，一句话。" },
          prompt: { type: "string", required: true, description: "交给他的完整任务（合同）。" },
          add_card: {
            type: "string",
            description:
              "如果这次建人是按某张加人卡建的，把那张卡的 id 原样带上（用户批准加人时会给）。页面据它核对「这张卡建出了谁」。",
          },
        },
        timeoutMs: 120_000,
        async execute(args, exec) {
          const context = "fresh";
          const member = await ctx.agentTeams.spawnTeammate(agent, {
            name: args.name,
            description: args.description,
            prompt: [{ type: "text", text: args.prompt }],
            context,
            provider: "spawn",
            signal: exec.signal,
          });
          await call("swarm", "meta", {
            kind: "member",
            refId: args.name,
            data: {
              role: args.role,
              label: args.label ?? null,
              routeId: args.route_id ?? null,
              ...(args.add_card ? { cardId: String(args.add_card) } : {}),
            },
          }).catch(() => undefined);
          return { member: { target: args.name, role: args.role, context } };
        },
      }),
    );
    register(
      defineTool({
        name: "research_task",
        description:
          "在任务板上建一个研究任务，并登记它挂在哪条路线、父任务是谁、是什么类型。有依赖就写 blocked_by。建任务走这个工具，不要再直接调 team_task_create，否则页面上的路线卡会是空的。",
        parameters: {
          subject: { type: "string", required: true, description: "任务标题。" },
          description: { type: "string", required: true, description: "任务详情与完成标准。" },
          kind: {
            type: "string",
            required: true,
            enum: ["root", "route", "research", "review", "verify", "synthesis", "other"],
          },
          route_id: { type: "string", description: "路线 id；根任务和汇总任务可以不填。" },
          parent_id: { type: "string", description: "父任务 id，如 task-1。" },
          blocked_by: { type: "array", items: { type: "string" }, description: "必须先完成的任务 id。" },
          write_scopes: { type: "array", items: { type: "string" }, description: "预计改动的目录。" },
        },
        timeoutMs: 60_000,
        async execute(args) {
          const task = await ctx.agentTeams.createTask(agent, {
            subject: args.subject,
            description: args.description,
            ...(args.blocked_by === undefined ? {} : { blockedBy: args.blocked_by }),
            ...(args.write_scopes === undefined ? {} : { writeScopes: args.write_scopes }),
          });
          await call("swarm", "meta", {
            kind: "task",
            refId: task.id,
            data: {
              kind: args.kind,
              routeId: args.route_id ?? null,
              parentId: args.parent_id ?? null,
            },
          }).catch(() => undefined);
          return task;
        },
      }),
    );
    register(
      defineTool({
        name: "research_status",
        description: "看这次群研现在的状态、额度用量、名册和任务板，用来决定下一步做什么。",
        parameters: {},
        timeoutMs: 30_000,
        async execute() {
          const outcome = await call("swarm", "status", {});
          if (outcome.error) return outcome.error;
          return outcome.result;
        },
      }),
    );
    register;
    // 负责人也能读团队目录（只读在别人子目录里写的东西），方便汇总。
    register(filesTool(teamRoot, "lead", true, report));
    for (const definition of researchTools(ctx, call, "lead", agent)) register(definition);
  };

  const installTeammate = (agent, scoped, memberName) => {
    // 队员目录在装工具时一起建好：第一次 research_files 读自己目录才不会 ENOENT。
    void mkdir(join(teamRoot, memberName), { recursive: true }).catch(() => {});
    // 先收窄工具：这一步失败就照实记下来，但不要把整个插件装崩。
    try {
      const visible = DENIED_TOOLS.filter((toolName) => {
        try {
          return scoped.tools.get(toolName) !== undefined;
        } catch {
          return false;
        }
      });
      if (visible.length) scoped.tools.restrict({ deny: visible });
    } catch (error) {
      void report(memberName, {
        kind: "summary",
        text: `工具收窄失败：${String(error?.message ?? error).slice(0, 200)}`,
      });
    }
    const role = ctx.agentTeams.membership(agent).role;
    const canReadOthers = memberRoleOf(memberName, role) !== "researcher";
    // 反驳 / 核实按审查任务要读被审的产出（PRD §5）：读的边界是 team/，写的边界仍是自己的目录。
    scoped.tools.register(
      filesTool(join(teamRoot, memberName), memberName, false, report, {
        readRoot: canReadOthers ? teamRoot : undefined,
        role: memberRoleOf(memberName, role),
      }),
    );
    for (const definition of researchTools(ctx, call, memberName, agent))
      scoped.tools.register(definition);
    // 干活时要在名册上显示「运行中」：工具一开始就跑一条状态上来。
    scoped.on("tools/pre-execute", async (exec, next) => {
      if (exec && (exec.agent === undefined || exec.agent === agent))
        void report(memberName, { kind: "tool", text: `开始 ${exec.name}`, tool: { name: exec.name, state: "running" } });
      return next();
    });
    // 可见工作记录：工具跑完就上报一条（参数和结果都截断，不含推理原文）。
    scoped.on("tools/result", (exec, result) => {
      if (!exec || (exec.agent !== undefined && exec.agent !== agent)) return;
      const failed = result?.isError === true || result?.error !== undefined;
      void report(memberName, {
        kind: "tool",
        text: `调用 ${exec.name}`,
        tool: {
          name: exec.name,
          state: failed ? "failed" : "done",
          args: clamp(JSON.stringify(exec.arguments ?? {}), 400),
          result: clamp(JSON.stringify(result?.value ?? result ?? {}), 400),
        },
      });
      // 队员发的消息由这里带名字上报：内核事件里分不出是谁发的（没有会话标记），
      // 只有插件知道自己是哪个队员。
      const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
      if (exec.name === "send_message" && !failed) {
        void report(memberName, {
          kind: "message_out",
          text: clamp(String(args.message ?? ""), 600),
          to: typeof args.target === "string" ? args.target : null,
        });
      }
    });
  };

  /**
   * 步骤边界取一次待送的用户消息，对这名 agent 调 steer（下一次边界就到）。
   *
   * DSH 的 `agent.steer(message)` 就是「Submit steering for the nearest step」：
   * 空闲时它会自己开一轮，运行中则插到最近的步骤边界。控制面只负责排队和回执，
   * 真正把消息送进会话的是这里，所以不再依赖 JSON-RPC 的 prompt 接口。
   */
  const steerPending = async (agent, memberName) => {
    if (!agent || typeof agent.steer !== "function") return;
    const now = Date.now();
    const last = steerAt.get(agent) ?? 0;
    if (now - last < 1500) return; // 一次工具调用只取一次，别把控制面打爆
    steerAt.set(agent, now);
    const picked = await call
      .post("/kernel/inbox", { member: memberName })
      .catch(() => null);
    const messages = picked?.result?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return;
    for (const message of messages) {
      const text = String(message?.text ?? "");
      if (!text) continue;
      try {
        agent.steer({
          id: message.id ?? globalThis.crypto.randomUUID(),
          role: "user",
          content: [{ type: "text", text }],
          source: { kind: "user-rpc" },
        });
        void report(memberName, {
          kind: "summary",
          text: `收到用户插话并交给这一轮的下一步：${text.slice(0, 80)}`,
        });
      } catch (error) {
        void report(memberName, {
          kind: "summary",
          text: `用户插话没能交给下一步：${String(error?.message ?? error).slice(0, 160)}`,
        });
      }
    }
  };
  const steerAt = new WeakMap();

  const install = (agent) => {
    if (installed.has(agent)) return;
    let membership;
    try {
      membership = ctx.agentTeams.tryMembership(agent);
    } catch (error) {
      if (process.env.REINLAB_SWARM_DEBUG === "1") throw error;
      membership = undefined;
    }
    if (membership === undefined) {
      debug(`${agent?.id} 不是团队成员，跳过`);
      return;
    }
    const scoped = agent.ctx;
    const role = membership.role;
    const memberName = membership.name;
    try {
      if (role === "lead") installLead(agent, scoped);
      else installTeammate(agent, scoped, memberName);
    } catch (error) {
      if (process.env.REINLAB_SWARM_DEBUG === "1") {
        process.stderr.write(`[reinlab-swarm] 装载 ${memberName} 失败：${error?.stack ?? error}\n`);
        throw error;
      }
      void report(memberName, {
        kind: "summary",
        text: `研究工具装载失败：${String(error?.message ?? error).slice(0, 200)}`,
      });
      return;
    }
    // 负责人和队员都在自己的工具边界看一眼：控制面有没有用户的话要交给这一步。
    scoped.on("tools/pre-execute", async (_exec, next) => {
      void steerPending(agent, memberName);
      return next();
    });
    installed.set(agent, true);
    debug(`${memberName} 工具已装载（${role}）`);
  };

  const debug = (line) => {
    if (process.env.REINLAB_SWARM_DEBUG === "1") process.stderr.write(`[reinlab-swarm] ${line}\n`);
  };
  debug("apply: 已装载");
  for (const agent of ctx.agents.list()) install(agent);
  ctx.on("agent/created", ({ agent }) => {
    debug(`agent/created ${agent?.id} 已注册=${ctx.agents.get(agent?.id) === agent}`);
    install(agent);
  });
  ctx.on("agent/disposed", ({ agent }) => installed.delete(agent));
  ctx.effect(() => () => installed.clear(), "reinlab-swarm.tools()");
}


/** research_submit / research_query / research_register_approach：负责人和队员共用一套。 */
function researchTools(ctx, call, memberName, agent) {
  return [
    defineTool({
      name: "research_submit",
      description:
        "把研究的产出交到黑板上：结论（必须引用至少一条证据，或者写成负结果）、证据、问题、回答、求助、决定。先落库再标任务完成；同一次提交重试用同一个 submission_id，不会记两遍。",
      parameters: {
        kind: {
          type: "string",
          required: true,
          enum: ["claim", "negative", "evidence", "question", "answer", "help", "decision"],
        },
        submission_id: {
          type: "string",
          description: "幂等键。重试同一次提交要原样带上（不给就由插件生成）。",
        },
        task_id: { type: "string", description: "这条产出属于哪个任务（task-2 之类）。" },
        route_id: { type: "string", description: "属于哪条路线；不填就用你自己的路线。" },
        claim: {
          type: "object",
          description: "kind=claim/negative 时用。",
          properties: {
            text: { type: "string", required: true, description: "具体主张，写清适用条件和范围。" },
            basis: {
              type: "string",
              enum: ["checked_fact", "source_claim", "inference", "observation"],
              description: "依据类型：核对过的事实 / 来源自己的说法 / 我们的推断 / 实测观察。",
            },
            conditions: { type: "array", items: { type: "string" }, description: "适用条件。" },
            claim_id: { type: "string", description: "改自己之前交的结论时填原 claim id。" },
            negative: {
              type: "object",
              description: "负结果：找过什么、范围、没找到什么。",
              properties: {
                searched: { type: "string", required: true },
                scope: { type: "string" },
                not_found: { type: "string", required: true },
              },
            },
          },
        },
        evidence: {
          type: "array",
          description: "这次一并交的证据。同来源 + 同版本 + 同定位只记一条。",
          items: {
            type: "object",
            properties: {
              source: {
                type: "object",
                required: true,
                properties: {
                  kind: {
                    type: "string",
                    required: true,
                    enum: ["paper", "web", "code", "data", "proof", "other"],
                  },
                  title: { type: "string", required: true },
                  ref: {
                    type: "string",
                    required: true,
                    description: "arXiv 号 / DOI / URL / 资产 id。",
                  },
                  asset_id: { type: "string" },
                  version: { type: "string", description: "如 v3。" },
                },
              },
              locator: {
                type: "object",
                description: "定位：章节 / 表号 / 图号 + 原文摘句。页码可选，没有不算降级。",
                properties: {
                  section: { type: "string", description: "如 §4.2 / Table 2 / Figure 3。" },
                  quote: { type: "string", description: "原文摘句，逐字。" },
                  page: { type: "integer" },
                  lines: { type: "string" },
                },
              },
              access: { type: "string", enum: ["full_text", "abstract_only", "unavailable"] },
              how: { type: "string", required: true, description: "怎么拿到的：检索 / 下载 / 实测。" },
            },
          },
        },
        text: { type: "string", description: "kind=question/answer/help/decision 时的正文。" },
        to: { type: "string", description: "提问 / 求助指定接收者；不填就是公开。" },
        answer_to: { type: "string", description: "kind=answer 时，回答的是哪条留言（post id）。" },
      },
      timeoutMs: 60_000,
      async execute(args) {
        const submissionId =
          typeof args.submission_id === "string" && args.submission_id !== ""
            ? args.submission_id
            : globalThis.crypto.randomUUID();
        const payload = {
          kind: args.kind,
          submissionId,
          member: memberName,
          ...(args.task_id ? { taskId: args.task_id } : {}),
          ...(args.route_id ? { routeId: args.route_id } : {}),
          ...(args.claim
            ? {
                claim: {
                  text: args.claim.text,
                  basis: args.claim.basis,
                  conditions: args.claim.conditions,
                  claimId: args.claim.claim_id,
                  ...(args.claim.negative
                    ? {
                        negative: {
                          searched: args.claim.negative.searched,
                          scope: args.claim.negative.scope ?? "",
                          notFound: args.claim.negative.not_found ?? "",
                        },
                      }
                    : {}),
                },
              }
            : {}),
          ...(Array.isArray(args.evidence)
            ? {
                evidence: args.evidence.map((entry) => ({
                  source: {
                    kind: entry.source?.kind,
                    title: entry.source?.title,
                    ref: entry.source?.ref,
                    assetId: entry.source?.asset_id,
                    version: entry.source?.version,
                  },
                  locator: entry.locator
                    ? {
                        section: entry.locator.section,
                        quote: entry.locator.quote,
                        page: entry.locator.page,
                        lines: entry.locator.lines,
                      }
                    : null,
                  access: entry.access ?? "full_text",
                  how: entry.how,
                })),
              }
            : {}),
          ...(typeof args.text === "string" ? { text: args.text } : {}),
          ...(args.answer_to ? { answerTo: args.answer_to } : {}),
          post:
            typeof args.text === "string"
              ? { text: args.text, ...(args.to ? { to: args.to } : {}) }
              : undefined,
        };
        const outcome = await call("swarm", "submit", payload);
        if (outcome.error) return outcome.error;
        // 先落库再完成任务：落库失败就不动任务板。
        if (args.task_id && (args.kind === "claim" || args.kind === "negative" || args.kind === "evidence")) {
          try {
            let task = null;
            try {
              task = ctx.agentTeams.getTask(agent, args.task_id);
            } catch {
              task = null;
            }
            if (task && task.status !== "completed")
              await ctx.agentTeams.updateTask(agent, {
                taskId: args.task_id,
                expectedRevision: task.revision,
                action: "complete",
              });
          } catch (error) {
            return {
              ...outcome.result,
              taskComplete: false,
              note: `提交已落库，但任务没有标完成：${String(error?.message ?? error).slice(0, 120)}。可以稍后再标。`,
            };
          }
        }
        return { ...outcome.result, repeated: outcome.result?.repeated === true };
      },
    }),
    defineTool({
      name: "research_query",
      description:
        "读黑板：按路线 / 任务过滤、按版本增量读，分页返回。独立阶段（前 2 轮）你只能看到自己那条路线的结论——这是服务端裁的，不是页面隐藏。",
      parameters: {
        route_id: { type: "string", description: "只看某条路线。" },
        task_id: { type: "string", description: "只看某个任务的产出。" },
        since_version: { type: "integer", description: "只读版本号大于它的结论（增量）。" },
        limit: { type: "integer", description: "最多返回几条，默认 30。" },
      },
      timeoutMs: 30_000,
      async execute(args) {
        const outcome = await call("swarm", "query", {
          member: memberName,
          ...(args.route_id ? { routeId: args.route_id } : {}),
          ...(args.task_id ? { taskId: args.task_id } : {}),
          ...(args.since_version ? { sinceVersion: args.since_version } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });
        return outcome.error ?? outcome.result;
      },
    }),
    defineTool({
      name: "research_review_claim",
      description:
        "审一条候选结论：独立反驳（refute）、要求补证据（need_evidence）、独立核实（verify）、降级/证伪（downgrade）。不能审自己交的结论；核实必须自己回原始出处核，把核到的证据一起交上来，不能只复述反驳意见。每条结论最多两轮反驳。",
      parameters: {
        claim_id: { type: "string", required: true, description: "要审的结论 id。" },
        claim_version: { type: "integer", description: "审哪一版；不填就审当前最新版。" },
        kind: {
          type: "string",
          required: true,
          enum: ["refute", "need_evidence", "verify", "downgrade"],
        },
        verdict: {
          type: "string",
          required: true,
          enum: ["upheld", "rejected", "verified", "not_verifiable", "pending"],
          description:
            "判定：反驳成立 upheld / 不成立 rejected；核实通过 verified / 核不了 not_verifiable；待定 pending。",
        },
        reason: {
          type: "string",
          required: true,
          description: "看到了什么、为什么这样判（核实要写清回到哪一处原文核的）。",
        },
        evidence: {
          type: "array",
          description: "核实必须带：你自己核到的那条证据（来源 + 章节/表号 + 摘句）。",
          items: {
            type: "object",
            properties: {
              source: {
                type: "object",
                required: true,
                properties: {
                  kind: {
                    type: "string",
                    required: true,
                    enum: ["paper", "web", "code", "data", "proof", "other"],
                  },
                  title: { type: "string", required: true },
                  ref: { type: "string", required: true },
                  version: { type: "string" },
                },
              },
              locator: {
                type: "object",
                properties: {
                  section: { type: "string" },
                  quote: { type: "string" },
                  page: { type: "integer" },
                  lines: { type: "string" },
                },
              },
              access: { type: "string", enum: ["full_text", "abstract_only", "unavailable"] },
              how: { type: "string", required: true },
            },
          },
        },
        task_id: { type: "string", description: "这次审查对应的任务 id。" },
      },
      timeoutMs: 90_000,
      async execute(args) {
        const outcome = await call("swarm", "review", {
          member: memberName,
          claimId: args.claim_id,
          ...(args.claim_version ? { claimVersion: args.claim_version } : {}),
          kind: args.kind,
          verdict: args.verdict,
          reason: args.reason,
          ...(args.task_id ? { taskId: args.task_id } : {}),
          ...(Array.isArray(args.evidence)
            ? {
                evidence: args.evidence.map((entry) => ({
                  source: {
                    kind: entry.source?.kind,
                    title: entry.source?.title,
                    ref: entry.source?.ref,
                    version: entry.source?.version,
                  },
                  locator: entry.locator
                    ? {
                        section: entry.locator.section,
                        quote: entry.locator.quote,
                        page: entry.locator.page,
                        lines: entry.locator.lines,
                      }
                    : null,
                  access: entry.access ?? "full_text",
                  how: entry.how,
                })),
              }
            : {}),
        });
        if (outcome.error) return outcome.error;
        // 审查落库之后再标任务完成（和交结论一样的顺序）。
        if (args.task_id) {
          try {
            let task = null;
            try {
              task = ctx.agentTeams.getTask(agent, args.task_id);
            } catch {
              task = null;
            }
            if (task && task.status !== "completed")
              await ctx.agentTeams.updateTask(agent, {
                taskId: args.task_id,
                expectedRevision: task.revision,
                action: "complete",
              });
          } catch (error) {
            return {
              ...outcome.result,
              taskComplete: false,
              note: `审查已落库，但任务没有标完成：${String(error?.message ?? error).slice(0, 120)}。`,
            };
          }
        }
        return outcome.result;
      },
    }),
    defineTool({
      name: "research_register_approach",
      description:
        "登记路线和方法族：同义的路线不会新开一条；卡住了就标阻塞并写缺口；要重开一条阻塞路线必须写明新机制。",
      parameters: {
        title: { type: "string", required: true, description: "路线名。" },
        idea: { type: "string", description: "这条路线怎么做。" },
        approach_family: { type: "string", description: "方法族，同义判断看它。" },
        route_id: { type: "string", description: "更新已有路线时填它的 id。" },
        tags: { type: "array", items: { type: "string" } },
        state: { type: "string", enum: ["active", "blocked", "stopped", "reopened", "merged"] },
        gap: { type: "string", description: "当前缺口。" },
        blocked_reason: { type: "string", description: "卡在哪（标阻塞时要写）。" },
        reopen_reason: { type: "string", description: "重开的新机制（重开时要写）。" },
      },
      timeoutMs: 30_000,
      async execute(args) {
        const outcome = await call("swarm", "approach", {
          ...(args.route_id ? { routeId: args.route_id } : {}),
          title: args.title,
          idea: args.idea ?? "",
          approachFamily: args.approach_family ?? args.title,
          tags: args.tags ?? [],
          ...(args.state ? { state: args.state } : {}),
          ...(args.gap ? { gap: args.gap } : {}),
          ...(args.blocked_reason ? { blockedReason: args.blocked_reason } : {}),
          ...(args.reopen_reason ? { reopenReason: args.reopen_reason } : {}),
        });
        return outcome.error ?? outcome.result;
      },
    }),
  ];
}

/** 目录读写工具：研究员只在自己目录；反驳/核实读整个 team/ 但只写自己目录。 */
export function filesTool(root, memberName, readOnly, report, options = {}) {
  const readRoot = options.readRoot ?? root;
  const role = options.role ?? "researcher";
  return defineTool({
    name: "research_files",
    description:
      role === "critic" || role === "verifier"
        ? "读：整个 team/ 目录（各研究员的交付都能读，这是审查需要的）；写：只写自己的目录。"
        : readOnly
          ? "在团队的 team/ 目录里列目录或读文件（别人写的东西只能读）。"
          : "在属于你自己的研究子目录里列、读、写文件。只能碰这个目录里的路径。",
    parameters: {
      op: { type: "string", required: true, enum: ["list", "read", "write"] },
      path: { type: "string", description: "相对自己目录的路径；列目录可以不写。" },
      text: { type: "string", description: "write 时写入的内容。" },
    },
    timeoutMs: 30_000,
    async execute(args) {
      try {
        // 队员常把路径写成「自己的名字/文件」（像 team 相对路径）：剥掉这一层，
        // 它的根本来就是 team/<名字>/。
        let rel = typeof args.path === "string" ? args.path.replace(/^(\.\/)+/, "") : args.path;
        if (typeof rel === "string" && rel.startsWith(memberName + "/"))
          rel = rel.slice(memberName.length + 1);
        const path2 = rel;
        switch (args.op) {
          case "list": {
            const target = path2 ? await resolveInside(readRoot, path2) : { target: readRoot };
            const entries = await readdir(target.target, { withFileTypes: true }).catch((error) => {
              // 目录还没建过就当空的：第一次看自己目录不该报错。
              if (error?.code === "ENOENT") return [];
              throw error;
            });
            return {
              path: path2 ?? ".",
              entries: entries.slice(0, 200).map((entry) => ({
                name: entry.name,
                kind: entry.isDirectory() ? "dir" : "file",
              })),
            };
          }
          case "read": {
            const resolved = await resolveInside(readRoot, path2 ?? "");
            const info = await stat(resolved.target);
            if (!info.isFile()) return { error: { code: "NOT_A_FILE", message: "这不是文件。" } };
            if (info.size > MAX_FILE_BYTES)
              return { error: { code: "TOO_LARGE", message: "文件太大，读不了。" } };
            const text = await readFile(resolved.target, "utf8");
            return { path: path2, text: text.slice(0, MAX_FILE_BYTES) };
          }
          case "write": {
            if (readOnly)
              return { error: { code: "READ_ONLY", message: "负责人这档只读团队目录。" } };
            if (typeof args.text !== "string")
              return { error: { code: "TEXT_REQUIRED", message: "要写什么？" } };
            const resolved = await resolveInside(root, path2 ?? "");
            await mkdir(dirname(resolved.target), { recursive: true });
            await writeFile(resolved.target, args.text.slice(0, MAX_FILE_BYTES), {
              mode: 0o600,
            });
            await report(memberName, {
              kind: "output",
              text: `写了自己的记录：${path2}`,
            });
            return { path: path2, bytes: args.text.length };
          }
          default:
            return { error: { code: "OP_UNSUPPORTED", message: "只支持 list / read / write。" } };
        }
      } catch (error) {
        const code = String(error?.message ?? error);
        const missing = /^ENOENT/.test(code);
        return {
          error: {
            code: code.startsWith("PATH_") ? code : missing ? "NOT_FOUND" : "FILES_FAILED",
            message: missing
              ? "这个路径还不存在：先写再读。你自己的目录是 team/<你的名字>/，用相对路径就行。"
              : code === "PATH_OUTSIDE_SCOPE"
                ? "这个路径在你自己的目录外面，不能读写。"
                : `没有成功：${code.slice(0, 200)}`,
          },
        };
      }
    },
  });
}
