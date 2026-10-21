import { createOpenScienceClient } from "@synsci/sdk/v2";
import { z } from "zod";
import { scopeDenied, type RoleProject } from "./role-project";
import {
  assertProject,
  projectGrants,
  projectPlugin,
} from "./project-authority";
const Input = z
  .object({
    sessionID: z.string().min(1),
    requestID: z
      .string()
      .min(1)
      .max(200)
      .refine((v) => v === v.trim()),
    message: z
      .string()
      .min(1)
      .max(1000000)
      .refine((v) => v.trim().length > 0),
  })
  .strict();
type Reply<T> = { data?: T; error?: unknown; response?: Response };
const unavailable = () =>
  Object.assign(new Error("账户执行内核暂时不可用；请按原请求编号检查收据。"), {
    code: "OS_UNAVAILABLE",
    status: 503,
  });
const Decision = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("permission"),
      sessionID: z.string().min(1),
      requestID: z.string().min(1).max(200),
      reply: z.enum(["once", "session", "reject"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("question"),
      sessionID: z.string().min(1),
      requestID: z.string().min(1).max(200),
      answers: z.array(z.array(z.string().max(4000)).max(64)).max(64),
    })
    .strict(),
  z
    .object({
      kind: z.literal("question_reject"),
      sessionID: z.string().min(1),
      requestID: z.string().min(1).max(200),
    })
    .strict(),
]);
function responseFailure(error: unknown, status: number | undefined) {
  const body =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  if (status === 400 && body.error === "invalid_answer")
    return Object.assign(new Error("问题答案不符合选项要求。"), {
      code: "INVALID_ANSWER",
      status: 400,
    });
  if (status === 409) {
    if (
      body.error === "cursor_expired" &&
      Number.isSafeInteger(body.oldestSequence) &&
      Number(body.oldestSequence) > 0
    )
      return Object.assign(
        new Error("观察游标已过期，需要恢复快照并记录缺口。"),
        {
          code: "CURSOR_EXPIRED",
          status: 409,
          oldestSequence: Number(body.oldestSequence),
        },
      );
    if (
      body.error === "cursor_ahead" &&
      Number.isSafeInteger(body.latestSequence) &&
      Number(body.latestSequence) >= 0
    )
      return Object.assign(new Error("观察游标超出内核历史，需要核对绑定。"), {
        code: "CURSOR_AHEAD",
        status: 409,
        latestSequence: Number(body.latestSequence),
      });
    const code =
      body.error === "decision_expired"
        ? "DECISION_EXPIRED"
        : body.error === "decision_conflict"
          ? "DECISION_CONFLICT"
          : body.error === "session_busy"
            ? "SESSION_BUSY"
            : "IDEMPOTENCY_CONFLICT";
    return Object.assign(new Error("执行内核拒绝冲突或过期的操作。"), {
      code,
      status: 409,
    });
  }
  if (status === 404)
    return Object.assign(new Error("执行内核中不存在该绑定。"), {
      code: "OS_NOT_FOUND",
      status: 404,
    });
  return unavailable();
}
export class RoleRuntime {
  private smokeBusy = false;
  private smokeSetting = false;
  private smokeCleanup: (() => Promise<void>) | undefined;
  private readonly client;
  private readonly sessions = new Set<string>();
  private readonly timeoutMs: number;
  private readonly delegation: boolean;
  constructor(
    private readonly options: {
      baseUrl: string;
      token: string;
      project: RoleProject;
      timeoutMs?: number;
      testOnlyDelegation?: boolean;
    },
  ) {
    this.options = Object.freeze({ ...options });
    this.delegation = options.testOnlyDelegation === true;
    if (this.delegation && process.env.NODE_ENV !== "test") throw scopeDenied();
    const url = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      options.token.length < 32
    )
      throw scopeDenied();
    this.timeoutMs = options.timeoutMs ?? 10000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 100 ||
      this.timeoutMs > 30000
    )
      throw scopeDenied();
    this.client = createOpenScienceClient({
      baseUrl: url.origin,
      directory: options.project.directory,
      headers: { Authorization: "Bearer " + options.token },
    });
  }
  private async bound(sessionID?: string) {
    await assertProject(this.options.project);
    if (sessionID && !this.sessions.has(sessionID)) throw scopeDenied();
  }
  private async call<T>(
    work: (options: { signal: AbortSignal }) => Promise<Reply<T>>,
  ): Promise<T> {
    try {
      const result = await work({
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (result.error || !result.data)
        throw responseFailure(result.error, result.response?.status);
      return result.data;
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        [
          "INVALID_ANSWER",
          "IDEMPOTENCY_CONFLICT",
          "OS_NOT_FOUND",
          "CURSOR_EXPIRED",
          "CURSOR_AHEAD",
          "DECISION_EXPIRED",
          "DECISION_CONFLICT",
          "SESSION_BUSY",
        ].includes(String(error.code))
      )
        throw error;
      throw unavailable();
    }
  }
  private async requirePlugin() {
    const required = await projectPlugin(this.options.project);
    const config = await this.call((options) =>
      this.client.global.config.get(options),
    );
    if (!config.plugin?.includes(required)) throw scopeDenied();
    return config;
  }
  private async grantSession(sessionID: string) {
    for (const grant of await projectGrants(this.options.project))
      await this.call((options) =>
        this.client.session.filesystem.grant(
          {
            directory: this.options.project.directory,
            sessionID,
            ...grant,
            scope: "session",
          },
          options,
        ),
      );
  }
  async createSession(title = "研究角色会话", sessionID?: string) {
    if (sessionID !== undefined && !/^ses_[A-Za-z0-9]{8,80}$/.test(sessionID))
      throw scopeDenied();
    await this.bound();
    await this.requirePlugin();
    const session = await this.call((options) =>
      this.client.session.create(
        {
          directory: this.options.project.directory,
          title,
          workspace: "project",
          ...(sessionID ? { id: sessionID } : {}),
        },
        options,
      ),
    );
    if (
      sessionID &&
      (session.id !== sessionID ||
        session.directory !== this.options.project.directory ||
        session.workspace !== "project" ||
        session.parentID)
    )
      throw scopeDenied();
    await this.grantSession(session.id);
    this.sessions.add(session.id);
    return { sessionID: session.id };
  }
  async restoreSession(sessionID: string) {
    if (!/^ses_[A-Za-z0-9]{8,80}$/.test(sessionID)) throw scopeDenied();
    await this.bound();
    await this.requirePlugin();
    const session = await this.call((options) =>
      this.client.session.get(
        { directory: this.options.project.directory, sessionID },
        options,
      ),
    ).catch((error) => {
      if (error?.code === "OS_NOT_FOUND") throw scopeDenied();
      throw error;
    });
    if (
      session.id !== sessionID ||
      session.directory !== this.options.project.directory ||
      session.workspace !== "project" ||
      session.parentID
    )
      throw scopeDenied();
    await this.grantSession(sessionID);
    this.sessions.add(sessionID);
    return { sessionID };
  }
  /** Trusted CLI admin operation for a NEW dedicated smoke account only. Never exposed by reader(). */
  async configureSmokeGateway(input: {
    origin: string;
    token: string;
  }): Promise<{ configured: true; outputCap: 1024; cleanup(): Promise<void> }> {
    const parsed = z
      .object({
        origin: z.string(),
        token: z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .refine((value) => !/^sk-/i.test(value)),
      })
      .strict()
      .safeParse(input);
    if (!parsed.success || this.smokeBusy) throw scopeDenied();
    const match =
      /^http:\/\/(host\.docker\.internal|127\.0\.0\.1):([0-9]{1,5})\/?$/.exec(
        parsed.data.origin,
      );
    if (
      !match ||
      Number(match[2]) < 1 ||
      Number(match[2]) > 65535 ||
      (match[1] === "127.0.0.1" && process.env.NODE_ENV !== "test")
    )
      throw scopeDenied();
    const origin = new URL(parsed.data.origin).origin;
    this.smokeBusy = true;
    this.smokeSetting = true;
    try {
      await this.bound();
      const config = await this.requirePlugin();
      const providers = await this.call((options) =>
        this.client.provider.list(
          { directory: this.options.project.directory },
          options,
        ),
      );
      if (
        !Array.isArray(providers.connected) ||
        providers.connected.length ||
        Object.values(config.provider ?? {}).some(
          (provider) => provider.options?.apiKey !== undefined,
        )
      )
        throw scopeDenied();
      const original = await this.call((options) =>
        this.client.global.configRawGet(options),
      );
      if (typeof original.content !== "string") throw unavailable();
      let restore = true,
        remove = true,
        running: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        if (running) return running;
        running = (async () => {
          let failed = false;
          if (restore)
            try {
              await this.call((options) =>
                this.client.global.configRawSet(
                  { content: original.content },
                  options,
                ),
              );
              restore = false;
            } catch {
              failed = true;
            }
          if (remove)
            try {
              await this.call((options) =>
                this.client.auth.remove({ providerID: "deepseek" }, options),
              );
              remove = false;
            } catch {
              failed = true;
            }
          if (failed) throw unavailable();
          this.smokeBusy = false;
          this.smokeCleanup = undefined;
        })().finally(() => {
          running = undefined;
        });
        return running;
      };
      this.smokeCleanup = cleanup;
      try {
        await this.call((options) =>
          this.client.auth.set(
            {
              providerID: "deepseek",
              auth: { type: "api", key: parsed.data.token },
            },
            options,
          ),
        );
        await this.call((options) =>
          this.client.global.config.update(
            {
              config: {
                model: "deepseek/deepseek-v4-flash",
                small_model: "deepseek/deepseek-v4-flash",
                enabled_providers: ["deepseek"],
                agent: { title: { disable: true } },
                provider: {
                  deepseek: {
                    options: { baseURL: origin + "/v1" },
                    models: {
                      "deepseek-v4-flash": {
                        reasoning: false,
                        limit: { context: 1048576, output: 1024 },
                      },
                    },
                  },
                },
              },
            },
            options,
          ),
        );
      } catch {
        try {
          await cleanup();
        } catch {
          /* Explicit cleanupSmokeGateway can retry remaining cleanup only. */
        }
        throw unavailable();
      }
      return Object.freeze({
        configured: true as const,
        outputCap: 1024 as const,
        cleanup: async () => {
          await this.cleanupSmokeGateway();
        },
      });
    } catch (error) {
      if (!this.smokeCleanup) this.smokeBusy = false;
      throw error;
    } finally {
      this.smokeSetting = false;
    }
  }
  async cleanupSmokeGateway(): Promise<{ cleaned: true }> {
    if (this.smokeSetting) throw scopeDenied();
    await this.smokeCleanup?.();
    return { cleaned: true };
  }
  async prompt(raw: unknown) {
    const parsed = Input.safeParse(raw);
    if (!parsed.success) throw scopeDenied();
    const input = parsed.data;
    await this.bound(input.sessionID);
    await this.requirePlugin();
    return this.call((options) =>
      this.client.runtime.prompt(
        {
          ...input,
          directory: this.options.project.directory,
          effort: "normal",
          delegation: this.delegation,
        },
        options,
      ),
    );
  }
  async snapshot(sessionID: string) {
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.runtime.snapshot(
        { directory: this.options.project.directory, sessionID },
        options,
      ),
    );
  }
  async messages(sessionID: string) {
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.session.messages(
        { directory: this.options.project.directory, sessionID },
        options,
      ),
    );
  }
  async children(sessionID: string) {
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.session.children(
        { directory: this.options.project.directory, sessionID },
        options,
      ),
    );
  }
  async capabilities() {
    await this.bound();
    return this.call((options) =>
      this.client.runtime.capabilities(
        { directory: this.options.project.directory },
        options,
      ),
    );
  }
  async getRun(sessionID: string, runID: string) {
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.runtime.getRun(
        { directory: this.options.project.directory, sessionID, runID },
        options,
      ),
    );
  }
  async replay(sessionID: string, afterSequence: number) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw scopeDenied();
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.runtime.replay(
        { directory: this.options.project.directory, sessionID, afterSequence },
        options,
      ),
    );
  }
  async decide(raw: unknown) {
    const parsed = Decision.safeParse(raw);
    if (!parsed.success) throw scopeDenied();
    await this.bound(parsed.data.sessionID);
    await this.requirePlugin();
    return this.call((options) =>
      this.client.runtime.decide(
        {
          directory: this.options.project.directory,
          runtimeDecisionInput: parsed.data,
        },
        options,
      ),
    );
  }
  async cancel(sessionID: string, runID: string) {
    await this.bound(sessionID);
    return this.call((options) =>
      this.client.runtime.cancel(
        { directory: this.options.project.directory, sessionID, runID },
        options,
      ),
    );
  }
  async *subscribe(
    sessionID: string,
    afterSequence: number,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
      throw scopeDenied();
    await this.bound(sessionID);
    const lifetime = new AbortController(),
      active = AbortSignal.any([signal, lifetime.signal]);
    let failure: Error | undefined;
    const connectionFetch: typeof fetch = async (input, init) => {
      const deadline = new AbortController(),
        timer = setTimeout(() => deadline.abort(), this.timeoutMs);
      try {
        const response = await fetch(input, {
          ...init,
          signal: AbortSignal.any([active, deadline.signal]),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => undefined);
          failure = responseFailure(data, response.status);
        }
        return response;
      } catch {
        failure = unavailable();
        throw failure;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const events = await this.client.runtime.subscribe(
        { directory: this.options.project.directory, sessionID, afterSequence },
        {
          signal: active,
          fetch: connectionFetch,
          sseMaxRetryAttempts: 1,
          onSseError: () => {
            failure ??= unavailable();
          },
        },
      );
      for await (const event of events.stream) {
        if (active.aborted) break;
        yield event;
      }
      if (!active.aborted)
        throw (
          failure ??
          Object.assign(
            new Error("事件订阅已结束，需要按已提交游标重新连接。"),
            { code: "OS_STREAM_CLOSED", status: 503 },
          )
        );
    } finally {
      lifetime.abort();
    }
  }
  reader(): RuntimeObservationPort {
    return Object.freeze({
      snapshot: (sessionID: string) => this.snapshot(sessionID),
      messages: (sessionID: string) => this.messages(sessionID),
      getRun: (sessionID: string, runID: string) =>
        this.getRun(sessionID, runID),
      capabilities: () => this.capabilities(),
      replay: (sessionID: string, afterSequence: number) =>
        this.replay(sessionID, afterSequence),
      subscribe: (
        sessionID: string,
        afterSequence: number,
        signal: AbortSignal,
      ) => this.subscribe(sessionID, afterSequence, signal),
    });
  }
}
export type RuntimeObservationPort = Pick<
  RoleRuntime,
  "snapshot" | "messages" | "getRun" | "capabilities" | "replay" | "subscribe"
>;
