import { reflectsCredential as reflects } from "./credential-reflection";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createHash, randomUUID } from "node:crypto";
import type { ApiEnv } from "../api/context";
import { ApiFailure } from "../api/errors";
import { lockBudget } from "../budget";
import { appendEvent } from "../ledger";
import type { CapabilityAuthority } from "../mcp/authority";
import { readRuntimeConfiguration } from "../configuration";
import { DEEPSEEK_PRICING_VERSION } from "../bridge/openscience/deepseek-pricing";

export type ModelPort = {
  prepare(): Promise<(body: Buffer) => Promise<Response>>;
};
export function authorizedModelPort(
  file: string | undefined
): ModelPort | undefined {
  if (!file) return;
  return {
    async prepare() {
      const auth = readRuntimeConfiguration(file),
        now = Date.now();
      if (
        !auth.AUTHORIZATION_ID ||
        !Number.isFinite(Date.parse(auth.VALID_FROM)) ||
        !Number.isFinite(Date.parse(auth.VALID_UNTIL)) ||
        now < Date.parse(auth.VALID_FROM) ||
        now >= Date.parse(auth.VALID_UNTIL) ||
        auth.PRICING_VERSION !== DEEPSEEK_PRICING_VERSION
      )
        throw new ApiFailure(
          "MODEL_NOT_AUTHORIZED",
          503,
          "澄清真实模型尚未取得有效授权。"
        );
      const key = readRuntimeConfiguration(
        auth.MODEL_KEY_FILE
      ).DEEPSEEK_API_KEY;
      if (!key || /[\r\n]/.test(key))
        throw new ApiFailure(
          "MODEL_NOT_AUTHORIZED",
          503,
          "澄清模型凭据尚未就绪。"
        );
      return async (body) => {
        if (
          Date.now() < Date.parse(auth.VALID_FROM) ||
          Date.now() >= Date.parse(auth.VALID_UNTIL)
        )
          throw new ApiFailure(
            "MODEL_NOT_AUTHORIZED",
            503,
            "澄清真实模型授权已过期。"
          );
        if (reflects(body.toString(), [key])) throw Error("MODEL_CREDENTIAL_REFLECTION");
        const response = await fetch(
          "https://api.deepseek.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              authorization: "Bearer " + key,
              "Content-Type": "application/json",
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          }
        );
        const bytes = await boundedResponse(response);
        if (reflects(bytes.toString(), [key]))
          throw Error("MODEL_CREDENTIAL_REFLECTION");
        return new Response(bytes, {
          status: response.status,
          headers: { "Content-Type": "text/event-stream" },
        });
      };
    },
  };
}
async function boundedResponse(response: Response) {
  if (!response.body) throw Error("MODEL_RESPONSE_UNKNOWN");
  const reader = response.body.getReader();
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 512 * 1024) throw Error("MODEL_RESPONSE_LIMIT");
      parts.push(part.value);
    }
    return Buffer.concat(parts);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function modelMaximum(bytes: number, output: number) {
  return Math.ceil(((bytes + 4096) * 2160000 + output * 8640000) / 1000000);
}
export function registerClarifyModel(
  app: Hono<ApiEnv>,
  authority: CapabilityAuthority,
  port?: ModelPort
) {
  app.post(
    "/mcp/clarify-model",
    bodyLimit({
      maxSize: 65536,
      onError: (c) => c.json({ error: "MODEL_REQUEST_LIMIT" }, 413),
    }),
    async (c) => {
      let gated: { account: string; dossier: string; run: string } | undefined;
      let identity:
        | { account: string; dossier: string; run: string; hash: string }
        | undefined;
      try {
        if (
          c.req.header("origin") &&
          c.req.header("origin") !== new URL(c.req.url).origin
        )
          throw Error("MODEL_ORIGIN_DENIED");
        const token = c.req
            .header("authorization")
            ?.match(/^Bearer (\S+)$/)?.[1],
          auth = await authority.validateModel(token);
        if (
          auth.claims.role !== "research-clarify" ||
          auth.claims.version !== "1.2.0" ||
          auth.scope.grants.length !== 1 ||
          auth.scope.grants[0].name !== "papers.search"
        )
          throw Error("MODEL_SCOPE_DENIED");
        gated = {
          account: auth.claims.account,
          dossier: auth.claims.dossier,
          run: auth.claims.run,
        };
        const bytes = Buffer.from(await c.req.arrayBuffer()),
          body = JSON.parse(bytes.toString());
        if (
          Object.keys(body).some(key=>!["model","messages","max_tokens","n","stream","stream_options","tools","tool_choice","parallel_tool_calls","temperature","top_p","frequency_penalty","presence_penalty","seed","stop","response_format","thinking","reasoning_effort"].includes(key)) ||
          body.model !== "deepseek-flash" ||
          body.stream !== true ||
          body.thinking?.type !== "disabled" ||
          !Number.isInteger(body.max_tokens) ||
          body.max_tokens < 1 ||
          body.max_tokens > 256 ||
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
                    (part: any) =>
                      part.type !== "text" || typeof part.text !== "string"
                  )))
          ) ||
          reflects(bytes.toString(), [token!]) ||
          (body.tools ?? []).some(
            (t: any) =>
              ![
                "literature",
                "question",
                "reinlab_papers_search",
                "invalid",
              ].includes(t.function?.name)
          )
        )
          throw Error("MODEL_REQUEST_DENIED");
        if (!port)
          throw new ApiFailure(
            "MODEL_NOT_AUTHORIZED",
            503,
            "澄清真实模型未授权；本批只运行fixture验证。"
          );
        const send = await port.prepare(),
          hash = createHash("sha256").update(bytes).digest("hex"),
          maximum = modelMaximum(bytes.length, body.max_tokens);
        await authority.db.withAccount(auth.claims.account, async (client) => {
          await lockBudget(client, auth.claims.account);
          await authority.validateModelClient(client, token);
          const row = (
            await client.query(
              "select pricing_context from os_binding where run_id=$1",
              [auth.claims.run]
            )
          ).rows[0];
          const p = row?.pricing_context;
          if (
            !p ||
            p.pricingVersion !== DEEPSEEK_PRICING_VERSION ||
            p.usdCnyRate !== "7.2" ||
            !["CNY", "USD"].includes(p.currency) ||
            !["peak", "offpeak"].includes(p.window) ||
            !Number.isSafeInteger(p.validFrom) ||
            !Number.isSafeInteger(p.validUntil) ||
            p.validFrom >= p.validUntil ||
            Date.now() < p.validFrom ||
            Date.now() >= p.validUntil
          )
            throw new ApiFailure(
              "PRICE_WINDOW_UNVERIFIED",
              503,
              "澄清费用窗口未核实。"
            );
          await client.query(
            "insert into clarify_model_request(account_id,dossier_id,run_id,body_hash,maximum_micros,state)values($1,$2,$3,$4,$5,'forwarding')",
            [
              auth.claims.account,
              auth.claims.dossier,
              auth.claims.run,
              hash,
              maximum,
            ]
          );
          await appendEvent(client, auth.claims.account, {
            dossierId: auth.claims.dossier,
            runId: auth.claims.run,
            roleId: "research-clarify",
            kind: "gate",
            action: "clarify_model_admitted",
            payload: { maximumMicros: maximum },
            dedupeKey: "clarify-model:" + hash,
          });
        });
        identity = {
          account: auth.claims.account,
          dossier: auth.claims.dossier,
          run: auth.claims.run,
          hash,
        };
        const response = await send(bytes),
          result = await boundedResponse(response),
          text = result.toString();
        let receipt: any;
        let usage = false,
          done = false,
          error = false,
          finished = false;
        for (const line of text.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") {
            done = true;
            continue;
          }
          try {
            const v = JSON.parse(raw);
            if (v.error) error = true;
            if (
              v.choices?.some((choice: any) =>
                ["stop", "tool_calls"].includes(choice.finish_reason)
              )
            )
              finished = true;
            if (v.usage) {
              if (
                usage &&
                JSON.stringify([
                  v.usage.prompt_tokens,
                  v.usage.completion_tokens,
                ]) !==
                  JSON.stringify([
                    receipt.promptTokens,
                    receipt.completionTokens,
                  ])
              )
                error = true;
              if (
                Number.isSafeInteger(v.usage.prompt_tokens) &&
                v.usage.prompt_tokens >= 0 &&
                [
                  "deepseek-flash",
                  "deepseek-v4-flash",
                  "DeepSeek-V4.1-Flash-1017",
                ].includes(v.model) &&
                v.usage.prompt_tokens <= bytes.length + 4096 &&
                Number.isSafeInteger(v.usage.completion_tokens) &&
                v.usage.completion_tokens >= 0 &&
                v.usage.completion_tokens <= body.max_tokens &&
                v.usage.prompt_tokens + v.usage.completion_tokens > 0 &&
                (v.usage.completion_tokens_details?.reasoning_tokens ?? 0) === 0
              ) {
                usage = true;
                receipt = {
                  responseModel: v.model,
                  pricingVersion: DEEPSEEK_PRICING_VERSION,
                  promptTokens: v.usage.prompt_tokens,
                  completionTokens: v.usage.completion_tokens,
                  costUpperMicros: Math.ceil(
                    (v.usage.prompt_tokens * 2160000 +
                      v.usage.completion_tokens * 8640000) /
                      1000000
                  ),
                  observedAt: Date.now(),
                  responseSha256: createHash("sha256")
                    .update(result)
                    .digest("hex"),
                };
              } else error = true;
            }
          } catch {
            error = true;
          }
        }
        if (
          !response.ok ||
          !done ||
          !finished ||
          !usage ||
          error ||
          reflects(text, [token!])
        )
          throw Error("MODEL_RESPONSE_UNKNOWN");
        await authority.db.withAccount(identity.account, (client) =>
          client.query(
            "update clarify_model_request set state='completed',response_receipt=$4 where account_id=$1 and dossier_id=$2 and body_hash=$3 and state='forwarding'",
            [
              identity!.account,
              identity!.dossier,
              hash,
              JSON.stringify(receipt),
            ]
          )
        );
        return new Response(result, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
          },
        });
      } catch (error) {
        if (gated && !identity)
          await authority.db
            .withAccount(gated.account, async (client) => {
              await lockBudget(client, gated!.account);
              await appendEvent(client, gated!.account, {
                dossierId: gated!.dossier,
                runId: gated!.run,
                roleId: "research-clarify",
                kind: "gate",
                action: "clarify_model_stopped",
                payload: {
                  reason:
                    error instanceof ApiFailure
                      ? error.code
                      : error instanceof Error &&
                        error.message === "CLARIFY_MODEL_LIMIT"
                      ? "CLARIFY_MODEL_LIMIT"
                      : "MODEL_REQUEST_DENIED",
                  message:
                    "澄清转发被拦截：授权、剩余预算或请求边界不满足；未自动重试或提高上限。",
                },
                dedupeKey: "clarify-stopped:" + randomUUID(),
              });
            })
            .catch(() => {});
        if (identity)
          await authority.db
            .withAccount(identity.account, async (client) => {
              await lockBudget(client, identity!.account);
              await client.query(
                "update clarify_model_request set state='unknown' where account_id=$1 and dossier_id=$2 and body_hash=$3 and state='forwarding'",
                [identity!.account, identity!.dossier, identity!.hash]
              );
              await client.query(
                "update budget_hold set state='unpriced' where run_id=$1 and state='reserved'",
                [identity!.run]
              );
              await appendEvent(client, identity!.account, {
                dossierId: identity!.dossier,
                runId: identity!.run,
                roleId: "research-clarify",
                kind: "error",
                action: "clarify_usage_unknown",
                payload: {
                  message: "澄清用量未知，已停止；不重试、不按零记账。",
                },
                dedupeKey: "clarify-unknown:" + identity!.hash,
              });
            })
            .catch(() => {});
        const status = error instanceof ApiFailure ? error.status : 409;
        return c.json(
          {
            error:
              error instanceof ApiFailure
                ? error.code
                : "CLARIFY_MODEL_STOPPED",
            message: "澄清模型未转发或结果未知；请查看账本，不能自动重试。",
          },
          status as 409
        );
      }
    }
  );
}
