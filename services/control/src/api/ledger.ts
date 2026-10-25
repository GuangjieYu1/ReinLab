import type { Hono } from "hono";
import { streamSSE, stream } from "hono/streaming";
import type { ApiEnv } from "./context";
import type { Database } from "../db/database";
import {
  readEvents,
  auditSnapshot,
  parseCursor,
  requireDossier,
} from "../ledger";
import { publicReadEvent } from "./read-view";

export function registerLedger(app: Hono<ApiEnv>, database: Database) {
  app.get("/v1/dossiers/:id/events", async (c) => {
    const dossierId = c.req.param("id"),
      accountId = c.get("accountId");
    let cursor = Math.max(
      parseCursor(c.req.query("after")),
      parseCursor(c.req.header("Last-Event-ID")),
    );
    await database.withAccount(accountId, (client) =>
      requireDossier(client, dossierId),
    );
    return streamSSE(
      c,
      async (stream) => {
        const controller = new AbortController();
        const abort = () => {
          controller.abort();
          stream.abort();
        };
        stream.onAbort(abort);
        c.req.raw.signal.addEventListener("abort", abort, { once: true });
        try {
          if (c.req.raw.signal.aborted) abort();
          if (!controller.signal.aborted) await stream.write(": connected\n\n");
          let heartbeat = Date.now();
          while (!controller.signal.aborted && !stream.aborted) {
            const batch = await database.withAccount(accountId, (client) =>
              readEvents(client, dossierId, cursor),
            );
            for (const event of batch) {
              if (controller.signal.aborted) break;
              await stream.writeSSE({
                id: String(event.seq),
                event: "ledger",
                data: JSON.stringify(
                  c.req.query("view") === "read"
                    ? publicReadEvent(event)
                    : event,
                ),
              });
              cursor = event.seq;
            }
            if (batch.length === 100) continue;
            if (Date.now() - heartbeat >= 15000) {
              await stream.write(": keepalive\n\n");
              heartbeat = Date.now();
            }
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, 250);
              controller.signal.addEventListener("abort", done, { once: true });
              if (controller.signal.aborted) done();
            });
          }
        } catch {
          if (!controller.signal.aborted && !stream.aborted)
            await stream
              .writeSSE({
                event: "error",
                data: JSON.stringify({
                  code: "STREAM_INTERRUPTED",
                  message: "事件流已中断，请用最后游标重连。",
                }),
              })
              .catch(() => {});
        } finally {
          c.req.raw.signal.removeEventListener("abort", abort);
        }
      },
      async () => {},
    );
  });
  app.get("/v1/dossiers/:id/audit", async (c) => {
    const snapshot = await database.withAccount(c.get("accountId"), (client) =>
      auditSnapshot(client, c.req.param("id")),
    );
    c.header("Content-Type", "application/x-ndjson; charset=UTF-8");
    c.header("Content-Disposition", 'attachment; filename="ledger.jsonl"');
    return stream(
      c,
      async (output) => {
        for (const event of snapshot.events)
          await output.writeln(JSON.stringify({ type: "event", ...event }));
        await output.writeln(
          JSON.stringify({ type: "summary", ...snapshot.summary }),
        );
      },
      async () => {},
    );
  });
}
