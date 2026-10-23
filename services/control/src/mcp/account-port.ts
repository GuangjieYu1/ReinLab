import { ApiFailure } from "../api/errors";
import { createProductionAccountResolver } from "../bridge/openscience/production-factory";
import type { Database } from "../db/database";
import type { CapabilityHandler } from "./engine";
import type { CardDeposit } from "./data-handlers";
import type { PaperDeposit } from "./papers";
const unavailable = () =>
  new ApiFailure("MCP_ACCOUNT_UNAVAILABLE", 503, "账户能力服务暂时不可用。");
export function accountPort(db: Database) {
  const resolve = createProductionAccountResolver(db);
  const post = async (
    account: string,
    endpoint: string,
    body: Record<string, unknown>,
  ) => {
    const connection = await resolve(account);
    const response = await fetch(connection.baseUrl + endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer " + connection.token,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw unavailable();
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw unavailable();
    }
  };
  const handlers = Object.fromEntries(
    ["list", "read", "write", "patch", "undo"].map(
      (operation) =>
        [
          "files." + operation,
          async (context, args) => {
            const grant = context.scope.grants.find(
              (g) => g.name === "files." + operation,
            );
            if (!grant) throw unavailable();
            return post(context.claims.account, "/reinlab/mcp/files", {
              dossier: context.claims.dossier,
              operation,
              args,
              writeTargets: grant.writeTargets,
            });
          },
        ] as [string, CapabilityHandler],
    ),
  );
  const deposit: PaperDeposit = async (context, assetId, bytes, metadata) => {
    if (!context.scope.grants.some((g) => g.name === "papers.fetch"))
      throw unavailable();
    await post(context.claims.account, "/reinlab/mcp/files", {
      dossier: context.claims.dossier,
      operation: "importPaper",
      args: { assetId, pdf: bytes?.toString("base64") ?? null, metadata },
      writeTargets: ["papers/"],
    });
  };
  return {
    handlers,
    deposit,
    cardDeposit: (async (context, id, name, card, writeTargets) => {
      if (
        name !== "quiz" ||
        !context.scope.grants.some((g) => g.name === "cards.card.quiz")
      )
        throw unavailable();
      const target = "read/quizzes/" + id + ".json";
      if (
        !writeTargets.some(
          (prefix) =>
            prefix === "read/quizzes/" ||
            (prefix.endsWith("/") && target.startsWith(prefix)),
        )
      )
        throw unavailable();
      await post(context.claims.account, "/reinlab/mcp/files", {
        dossier: context.claims.dossier,
        operation: "write",
        args: { path: target, content: JSON.stringify(card) },
        writeTargets,
      });
    }) as CardDeposit,
    cleanup: (account: string, runId: string) =>
      post(account, "/reinlab/mcp/cleanup", { runId }),
    bootstrap: (
      account: string,
      runId: string,
      token: string,
      controlUrl: string,
    ) => post(account, "/reinlab/mcp/bootstrap", { runId, token, controlUrl }),
  };
}
