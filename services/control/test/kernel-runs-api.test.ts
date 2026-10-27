import { it, expect } from "vitest";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { mcpFixture } from "./mcp-fixture";
import { createApp } from "../src/api/app";
import { KernelAuth } from "../src/kernel/auth";
import { KernelService } from "../src/kernel/service";
import type { HarnessFactory } from "../src/kernel/dsh/session";

const HOME = mkdtempSync(join(tmpdir(), "kernel-runs-"));

function completing(): HarnessFactory {
  return () => ({
    session: (_id: string) => ({
      run: async (_text, options) => {
        for (const type of ["turn/start", "tool/call", "tool/result"])
          options.onNotification?.({ method: "session.event", params: { event: { type, data: { type } } } });
        return {
          sessionId: "ds",
          events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }],
          finalResponse: "done",
        };
      },
    }),
    resumeSession: async () => ({
      run: async () => ({ sessionId: "ds", events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }], finalResponse: "done" }),
    }),
    close: async () => {},
  });
}

it("建立精读运行、读到已完成状态与内核事件，并可取消", async () => {
  process.env.REINLAB_CONTROL_URL = "http://control:3001";
  const f = await mcpFixture();
  try {
    const secret = randomBytes(48),
      issuer = "https://kernel-runs.fixture/auth/v1";
    const kernel = new KernelService({
      db: f.db,
      auth: new KernelAuth(generateKeyPairSync("ed25519").privateKey),
      factory: completing(),
      model: "deepseek-v4-flash",
      maxTokens: 4096,
      layout: {
        home: HOME,
        shimModule: "/app/shim.mjs",
        shimContainerModule: "/app/shim.mjs",
        dshModule: "/app/dsh.mjs",
        restrictPatch: "/opt/restrict.patch.yml",
        pluginEntry: "file:///opt/plugin/index.js",
        shimMode: "host",
        io: {
          mkdir: async (path: string) => void (await mkdir(path, { recursive: true, mode: 0o700 })),
          write: async (path: string, body: string) => void (await writeFile(path, body, { mode: 0o600 })),
          remove: async (path: string) => void (await rm(path, { force: true })),
        },
      },
    });
    const app = await createApp({ pool: f.pool, auth: { issuer, secret }, kernel });
    const token = await new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(issuer)
      .setAudience("authenticated")
      .setSubject(f.account)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);
    const request = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const created = await request("/v1/kernel/runs", {
      dossierId: f.dossier,
      query: "我听说 GPT 写了 700 多篇数学论文",
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let status: any;
    for (let i = 0; i < 100; i += 1) {
      status = await (await request(`/v1/kernel/runs/${id}`)).json();
      if (status.state === "completed") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(status.state).toBe("completed");
    expect(status.session.state).toBe("completed");
    expect(status.usage).toMatchObject({ known: false, requests: 0 });

    const events = (await (await request(`/v1/kernel/runs/${id}/events?after=0`)).json()) as {
      events: Array<{ kind: string; action: string }>;
      cursor: number;
    };
    expect(events.events.map((event) => event.action)).toEqual(["turn/start", "tool/call", "tool/result"]);
    expect(events.cursor).toBeGreaterThan(0);

    // A finished run cannot be cancelled.
    const cancelled = await request(`/v1/kernel/runs/${id}/cancel`, {});
    expect(cancelled.status).toBe(409);
  } finally {
    await f.close();
  }
}, 60_000);
