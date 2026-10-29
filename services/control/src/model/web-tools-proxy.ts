import type { Hono } from "hono";
import type { KernelAuth } from "../kernel/auth";
import { tokenOf, type RecordedUsage } from "./messages-proxy";

export type WebToolsProxyDependencies = {
  auth: KernelAuth;
  now: () => number;
  /** Provider origin, e.g. https://api.deepseek.com */
  providerBaseUrl: string;
  providerKey: string;
  /** 每次成功请求的次数费（官方：每千次成功请求 ¥5）。 */
  feeCny: string;
  /** Host-only transport with the real credential. */
  forward: (request: Request) => Promise<Response>;
  record: (usage: RecordedUsage) => Promise<void>;
};

type Operation = "search" | "fetch";

const succeeded = (operation: Operation, body: any) =>
  operation === "search"
    ? Array.isArray(body?.results) && body.results.length > 0
    : typeof body?.content === "string" && body.content.trim().length > 0;

/**
 * DeepSeek Search / Fetch API passthrough for the kernel's web tools.
 *
 * The kernel holds only a run token; the host key stays here. The provider's
 * own request/response shape is forwarded unchanged so its validation and error
 * guidance keep working. A successful call records its flat per-request fee.
 */
export function registerWebToolsProxy(
  app: Hono<any>,
  dependencies: WebToolsProxyDependencies,
) {
  const handle = (operation: Operation) => async (c: any) => {
    let claims: { account: string; dossier: string; run: string };
    try {
      claims = dependencies.auth.verify(tokenOf(c.req.raw), dependencies.now());
    } catch {
      return c.json({ error: { code: "KERNEL_TOKEN_INVALID", message: "运行令牌缺失或无效。" } }, 401);
    }
    const body = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return c.json({ error: { code: "WEB_BODY_INVALID", message: "请求体不是 JSON。" } }, 400);
    }
    const target = new URL(
      dependencies.providerBaseUrl.replace(/\/+$/, "") + "/v1/tools/" + operation,
    );
    let response: Response;
    try {
      response = await dependencies.forward(
        new Request(target, {
          method: "POST",
          body,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + dependencies.providerKey,
          },
          signal: c.req.raw.signal,
        }),
      );
    } catch (error) {
      return c.json(
        {
          error: {
            code: "WEB_PROVIDER_ERROR",
            message: `连不上 ${target.origin}：${String((error as Error)?.message ?? error).slice(0, 200)}`,
          },
        },
        502,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = (() => {
        try {
          const parsedBody = JSON.parse(text) as any;
          return String(parsedBody?.error?.message ?? parsedBody?.message ?? "").slice(0, 200);
        } catch {
          return text.slice(0, 200);
        }
      })();
      return c.json(
        {
          error: {
            code: "WEB_PROVIDER_STATUS",
            message: `DeepSeek ${operation} 返回 ${response.status}${detail ? "：" + detail : ""}`,
          },
        },
        response.status === 401 || response.status === 403 ? 502 : response.status,
      );
    }
    let payload: any;
    try {
      payload = JSON.parse(text);
    } catch {
      return c.json(
        { error: { code: "WEB_PROVIDER_ERROR", message: "DeepSeek 返回的不是 JSON。" } },
        502,
      );
    }
    if (succeeded(operation, payload))
      await dependencies
        .record({
          account: claims.account,
          dossier: claims.dossier,
          run: claims.run,
          provider: "deepseek",
          model: "tools-" + operation,
          known: true,
          // 次数费不含 token：这里如实记 0 token，费用单列。
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          costCny: dependencies.feeCny,
        })
        .catch(() => {});
    return new Response(text, {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
  app.post("/llm/deepseek/v1/tools/search", handle("search"));
  app.post("/llm/deepseek/v1/tools/fetch", handle("fetch"));
}
