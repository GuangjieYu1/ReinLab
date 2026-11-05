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
  /**
   * 记一条来路线索（18 广度返工）：search = 搜索结果里出现过；citation = 已抓页面里的外链。
   * 证据交上来时按这张表判 discovery，不问模型「你是怎么找到的」。
   */
  noteSources?: (input: {
    account: string;
    run: string;
    urls: string[];
    kind: "search" | "citation";
  }) => Promise<void>;
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
  // 同一份运行里，某个域名被抓了几次：用来给一句提示（只提示，不拦）。
  const domainHits = new Map<string, number>();
  const domainOf = (url: string): string => {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  };
  const hints = (run: string, url: string): string | null => {
    const host = domainOf(url);
    if (!host) return null;
    const key = run + "|" + host;
    const count = (domainHits.get(key) ?? 0) + 1;
    domainHits.set(key, count);
    if (count < 3) return null;
    return `这个域名（${host}）在本次运行里已经抓了第 ${count} 次；如果是在找「还有谁在做这件事」，换用 web_search 或换一个来源更省时间。`;
  };
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
    // 一次搜多个 query：上游是单 query 接口，这里并行发、合并去重，结果自然更多。
    const queries: string[] = (() => {
      if (operation !== "search") return [];
      const raw = parsed as { queries?: unknown; query?: unknown };
      const list = Array.isArray(raw.queries) ? raw.queries : [];
      const items = list
        .map((item) => String(item ?? "").trim())
        .filter((item) => item.length > 0)
        .slice(0, 5);
      return items;
    })();
    const send = async (payloadBody: string) =>
      dependencies.forward(
        new Request(target, {
          method: "POST",
          body: payloadBody,
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + dependencies.providerKey,
          },
          signal: c.req.raw.signal,
        }),
      );
    let response: Response;
    let merged: unknown = null;
    try {
      if (queries.length > 1) {
        // 多个 query：每个单独发（上游只吃单 query），合并去重。
        const bodies = queries.map((query) => {
          const clone = { ...(parsed as Record<string, unknown>) };
          delete clone.queries;
          clone.query = query;
          return JSON.stringify(clone);
        });
        const responses = await Promise.all(bodies.map((item) => send(item)));
        const parts = await Promise.all(responses.map((item) => item.text()));
        const okParts = parts
          .map((part) => {
            try {
              return JSON.parse(part) as { results?: Array<{ url?: string }> };
            } catch {
              return null;
            }
          })
          .filter(Boolean) as Array<{ results?: Array<{ url?: string }> }>;
        if (!okParts.length) response = responses[0];
        else {
          const seen = new Set<string>();
          const results = okParts.flatMap((part) => part.results ?? []).filter((item) => {
            const key = String(item?.url ?? "");
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          merged = { ...(okParts[0] as object), results: results.slice(0, 20) };
          response = new Response(JSON.stringify(merged), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
      } else {
        response = await send(body);
      }
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
    // 来路：搜索记结果 URL；抓取记页面里的外链（citation），并给「同域名反复抓」的提示。
    if (operation === "search") {
      const urls = (Array.isArray(payload?.results) ? payload.results : [])
        .map((item: any) => String(item?.url ?? item?.link ?? ""))
        .filter((url: string) => url.startsWith("http"));
      if (urls.length)
        await dependencies
          .noteSources?.({ account: claims.account, run: claims.run, urls, kind: "search" })
          .catch(() => {});
    } else {
      const content = String(payload?.content ?? "");
      const links = [...content.matchAll(/https?:\/\/[^\s)"'<>\\]+/g)]
        .map((match) => match[0].replace(/[.,;:]+$/, ""))
        .slice(0, 60);
      if (links.length)
        await dependencies
          .noteSources?.({ account: claims.account, run: claims.run, urls: links, kind: "citation" })
          .catch(() => {});
      const hint = hints(claims.run, content ? String(payload?.url ?? "") : "");
      if (hint) payload = { ...payload, hint };
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  };
  app.post("/llm/deepseek/v1/tools/search", handle("search"));
  app.post("/llm/deepseek/v1/tools/fetch", handle("fetch"));
}
