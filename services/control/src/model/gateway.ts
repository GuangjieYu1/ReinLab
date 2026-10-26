import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomUUID } from "node:crypto";
import type { ApiEnv } from "../api/context";
import { ApiFailure } from "../api/errors";
import { lockBudget } from "../budget";
import { appendEvent } from "../ledger";
import type { CapabilityAuthority } from "../mcp/authority";
import { modelMaximum, type ModelPort } from "../clarify/model";
import { reflectsCredential } from "../clarify/credential-reflection";
import { DEEPSEEK_PRICING_VERSION } from "../bridge/openscience/deepseek-pricing";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const denied = () => {
  throw Error("MODEL_REQUEST_DENIED");
};
const keys = new Set([
  "model",
  "messages",
  "max_tokens",
  "n",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "frequency_penalty",
  "presence_penalty",
  "seed",
  "stop",
  "response_format",
  "thinking",
  "reasoning_effort",
]);
async function responseBytes(response: Response) {
  if (!response.body) throw Error("MODEL_RESPONSE_UNKNOWN");
  const reader = response.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const p = await reader.read();
      if (p.done) break;
      size += p.value.length;
      if (size > 524288) throw Error("MODEL_RESPONSE_LIMIT");
      parts.push(p.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function receipt(bytes: Buffer, wireBytes: number, output: number) {
  let done = false,
    finished = false,
    truncated = false,
    usage: any;
  for (const line of bytes.toString().split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const text = line.slice(5).trim();
    if (text === "[DONE]") {
      done = true;
      continue;
    }
    const value = JSON.parse(text);
    if (value.error) throw Error("MODEL_RESPONSE_UNKNOWN");
    if (
      value.choices?.some((c: any) =>
        ["stop", "tool_calls"].includes(c.finish_reason),
      )
    )
      finished = true;
    if (value.choices?.some((c: any) => c.finish_reason === "content_filter"))
      throw Error("MODEL_RESPONSE_UNKNOWN");
    // Hitting the run's output ceiling is a complete, billable step: usage is
    // reported, the cost bound still holds, and the client may continue.
    if (value.choices?.some((c: any) => c.finish_reason === "length"))
      truncated = true;
    if (value.usage) {
      const u = value.usage;
      if (
        ![
          "deepseek-flash",
          "deepseek-v4-flash",
          "DeepSeek-V4.1-Flash-1017",
        ].includes(value.model) ||
        !Number.isSafeInteger(u.prompt_tokens) ||
        u.prompt_tokens < 0 ||
        u.prompt_tokens > wireBytes + 4096 ||
        !Number.isSafeInteger(u.completion_tokens) ||
        u.completion_tokens < 0 ||
        u.completion_tokens > output ||
        u.prompt_tokens + u.completion_tokens === 0 ||
        (u.completion_tokens_details?.reasoning_tokens ?? 0) !== 0
      )
        throw Error("MODEL_RESPONSE_UNKNOWN");
      const current = {
        responseModel: value.model,
        pricingVersion: DEEPSEEK_PRICING_VERSION,
        promptTokens: u.prompt_tokens,
        completionTokens: u.completion_tokens,
        costUpperMicros: Math.ceil(
          (u.prompt_tokens * 216 + u.completion_tokens * 864) / 100,
        ),
      };
      if (usage && JSON.stringify(usage) !== JSON.stringify(current))
        throw Error("MODEL_RESPONSE_UNKNOWN");
      usage = current;
    }
  }
  if (!done || !(finished || truncated) || !usage)
    throw Error("MODEL_RESPONSE_UNKNOWN");
  return {
    ...usage,
    truncated,
    observedAt: Date.now(),
    responseSha256: hash(bytes),
  };
}
/** Host-only paid egress. The account supplies a short-lived run token, never a provider key. */
export function registerRuntimeModel(
  app: Hono<ApiEnv>,
  authority: CapabilityAuthority,
  port?: ModelPort,
) {
  app.post(
    "/mcp/runtime-model",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "MODEL_REQUEST_LIMIT" }, 413),
    }),
    async (c) => {
      let identity:
        | {
            account: string;
            dossier: string;
            run: string;
            role: string;
            hash: string;
            clarify: boolean;
          }
        | undefined;
      let recognized:
        | { account: string; dossier: string; run: string; role: string }
        | undefined;
      try {
        if (
          c.req.header("origin") &&
          c.req.header("origin") !== new URL(c.req.url).origin
        )
          denied();
        const token = c.req
            .header("authorization")
            ?.match(/^Bearer (\S+)$/)?.[1],
          auth = await authority.validateRuntimeModel(token),
          bytes = Buffer.from(await c.req.arrayBuffer()),
          body = JSON.parse(bytes.toString()),
          clarify = auth.claims.role === "research-clarify";
        recognized = {
          account: auth.claims.account,
          dossier: auth.claims.dossier,
          run: auth.claims.run,
          role: auth.claims.role,
        };
        const output = clarify ? (["1.2.1", "1.2.2"].includes(auth.claims.version) ? 512 : 256) : 1024;
        if (
          Object.keys(body).some((k) => !keys.has(k)) ||
          body.model !== "deepseek-flash" ||
          body.stream !== true ||
          body.thinking?.type !== "disabled" ||
          !Number.isInteger(body.max_tokens) ||
          body.max_tokens < 1 ||
          body.max_tokens > output ||
          (body.n !== undefined && body.n !== 1) ||
          !Array.isArray(body.messages) ||
          !body.messages.length ||
          body.messages.length > 32 ||
          body.messages.some(
            (m: any) =>
              !["system", "user", "assistant", "tool"].includes(m.role) ||
              (m.content !== null &&
                typeof m.content !== "string" &&
                (!Array.isArray(m.content) ||
                  m.content.some(
                    (p: any) => p.type !== "text" || typeof p.text !== "string",
                  ))),
          ) ||
          reflectsCredential(bytes.toString(), [token!])
        )
          denied();
        if (!port)
          throw new ApiFailure(
            "MODEL_NOT_ENABLED",
            503,
            "本地真实模型默认关闭，请显式启用。",
          );
        const send = await port.prepare(),
          bodyHash = hash(bytes),
          maximum = modelMaximum(bytes.length, body.max_tokens);
        await authority.db.withAccount(auth.claims.account, async (client) => {
          await lockBudget(client, auth.claims.account);
          await authority.validateRuntimeModelClient(client, token);
          const bound = (
              await client.query(
                "select pricing_context,role_options,hold_id from os_binding where run_id=$1",
                [auth.claims.run],
              )
            ).rows[0],
            p = bound?.pricing_context;
          if (
            bound?.hold_id !== auth.claims.hold ||
            bound?.role_options?.model !== "deepseek/deepseek-v4-flash"
          )
            denied();
          if (
            !p ||
            p.pricingVersion !== DEEPSEEK_PRICING_VERSION ||
            p.usdCnyRate !== "7.2" ||
            !["CNY", "USD"].includes(p.currency) ||
            p.window !== "peak"
          )
            throw new ApiFailure(
              "PRICE_WINDOW_UNVERIFIED",
              503,
              "峰值费率配置不可用。",
            );
          const grants = bound.role_options.role.toolGrants,
            allowed = new Set(
              Object.keys(grants).filter(
                (k) =>
                  grants[k].permission !== "deny" &&
                  grants[k].risk !== "danger" &&
                  ![
                    "task",
                    "edit",
                    "write",
                    "patch",
                    "apply_patch",
                    "multiedit",
                  ].includes(k),
              ),
            );
          allowed.add("invalid");
          for (const grant of auth.scope.grants)
            allowed.add("reinlab_" + grant.name.replaceAll(".", "_"));
          if (
            (body.tools ?? []).some(
              (t: any) =>
                t.type !== "function" || !allowed.has(t.function?.name),
            )
          )
            throw new ApiFailure(
              "MODEL_TOOLS_DENIED",
              409,
              "出站工具不在运行白名单内。",
            );
          await client.query(
            "insert into runtime_model_request(account_id,dossier_id,run_id,hold_id,body_hash,wire_bytes,max_output,maximum_micros,state) values($1,$2,$3,$4,$5,$6,$7,$8,'forwarding')",
            [
              auth.claims.account,
              auth.claims.dossier,
              auth.claims.run,
              auth.claims.hold,
              bodyHash,
              bytes.length,
              body.max_tokens,
              maximum,
            ],
          );
          if (clarify)
            await client.query(
              "insert into clarify_model_request(account_id,dossier_id,run_id,body_hash,maximum_micros,max_output,state)values($1,$2,$3,$4,$5,$6,'forwarding')",
              [
                auth.claims.account,
                auth.claims.dossier,
                auth.claims.run,
                bodyHash,
                maximum, body.max_tokens,
              ],
            );
          await appendEvent(client, auth.claims.account, {
            dossierId: auth.claims.dossier,
            runId: auth.claims.run,
            roleId: auth.claims.role,
            kind: "gate",
            action: "model_http_reserved",
            payload: { maximumMicros: maximum, holdId: auth.claims.hold },
            dedupeKey: "model-http:" + bodyHash,
          });
        });
        identity = {
          account: auth.claims.account,
          dossier: auth.claims.dossier,
          run: auth.claims.run,
          role: auth.claims.role,
          hash: bodyHash,
          clarify,
        };
        // Revocation/hold changes while waiting for DB admission cannot grant new egress.
        await authority.validateRuntimeModel(token);
        const response = await send(bytes),
          result = await responseBytes(response);
        if (!response.ok || reflectsCredential(result.toString(), [token!]))
          throw Error("MODEL_RESPONSE_UNKNOWN");
        const proof = receipt(result, bytes.length, body.max_tokens);
        await authority.db.withAccount(identity.account, async (client) => {
          await lockBudget(client, identity!.account);
          await client.query(
            "update runtime_model_request set state='completed',response_receipt=$3 where account_id=$1 and run_id=$2 and body_hash=$4 and state='forwarding'",
            [identity!.account, identity!.run, JSON.stringify(proof), bodyHash],
          );
          if (clarify)
            await client.query(
              "update clarify_model_request set state='completed',response_receipt=$3 where account_id=$1 and run_id=$2 and body_hash=$4 and state='forwarding'",
              [
                identity!.account,
                identity!.run,
                JSON.stringify(proof),
                bodyHash,
              ],
            );
        });
        return new Response(result, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        if (recognized && !identity)
          await authority.db
            .withAccount(recognized.account, async (client) => {
              await lockBudget(client, recognized!.account);
              const reason =
                error instanceof ApiFailure
                  ? error.code
                  : error instanceof Error &&
                      ["MODEL_HOLD_LIMIT", "CLARIFY_MODEL_LIMIT"].includes(
                        error.message,
                      )
                    ? error.message
                    : "MODEL_REQUEST_DENIED";
              await appendEvent(client, recognized!.account, {
                dossierId: recognized!.dossier,
                runId: recognized!.run,
                roleId: recognized!.role,
                kind: "gate",
                action:
                  recognized!.role === "research-clarify"
                    ? "clarify_model_stopped"
                    : "model_http_stopped",
                payload: {
                  reason,
                  message:
                    "模型请求超过剩余预算、轮次或授权边界，已停止且未转发；不会提高上限或自动重试。",
                },
                dedupeKey: "model-stopped:" + randomUUID(),
              });
            })
            .catch(() => {});
        if (identity)
          await authority.db
            .withAccount(identity.account, async (client) => {
              await lockBudget(client, identity!.account);
              await client.query(
                "update runtime_model_request set state='unknown' where account_id=$1 and run_id=$2 and body_hash=$3 and state='forwarding'",
                [identity!.account, identity!.run, identity!.hash],
              );
              if (identity!.clarify)
                await client.query(
                  "update clarify_model_request set state='unknown' where account_id=$1 and run_id=$2 and body_hash=$3 and state='forwarding'",
                  [identity!.account, identity!.run, identity!.hash],
                );
              await client.query(
                "update budget_hold set state='unpriced' where account_id=$1 and id in(select hold_id from runtime_model_request where account_id=$1 and run_id=$2) and state='reserved'",
                [identity!.account, identity!.run],
              );
              await appendEvent(client, identity!.account, {
                dossierId: identity!.dossier,
                runId: identity!.run,
                roleId: identity!.role,
                kind: "error",
                action: "model_usage_unknown",
                payload: {
                  message: "模型用量未知，保留预留并停止；不重试、不记为零。",
                },
                dedupeKey: "model-unknown:" + identity!.hash,
              });
            })
            .catch(() => {});
        return c.json(
          {
            error:
              error instanceof ApiFailure
                ? error.code
                : "MODEL_FORWARDING_STOPPED",
            message: "模型转发被拦截；未放宽预算或自动重试。",
          },
          error instanceof ApiFailure ? error.status : 409,
        );
      }
    },
  );
}
