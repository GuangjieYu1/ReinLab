import { it, expect } from "vitest";
import { Hono } from "hono";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mcpFixture } from "./mcp-fixture";
import { CapabilitySigner } from "../src/mcp/token";
import { CapabilityAuthority } from "../src/mcp/authority";
import { registerClarifyModel, modelMaximum } from "../src/clarify/model";
import { reflectsCredential } from "../src/clarify/credential-reflection";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { DEEPSEEK_PRICING_VERSION } from "../src/bridge/openscience/deepseek-pricing";

async function fixture() {
  const f = await mcpFixture(undefined, false, "1.2.0", "research-clarify");
  await f.admin.query("update run set state='queued' where id=$1", [f.run]);
  await f.admin.query(
    "insert into read_clarification(account_id,dossier_id)values($1,$2)",
    [f.account, f.dossier]
  );
  await f.admin.query(
    "insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",
    [f.account, f.dossier, f.run]
  );
  const role = materializeHarnessRole(f.effective, await loadToolRegistry(), {
    dossierId: f.dossier,
    roleId: "research-clarify",
    modelRoutes: { cheap: "deepseek/deepseek-v4-flash" },
    memory: "",
  });
  await new BindingStore(f.db).prepare(f.account, f.run, {
    role,
    message: "fixture only",
  });
  await f.admin.query(
    "update os_binding set pricing_context=$2 where run_id=$1",
    [
      f.run,
      {
        currency: "CNY",
        window: "peak",
        pricingVersion: DEEPSEEK_PRICING_VERSION,
        usdCnyRate: "7.2",
        validFrom: 1,
        validUntil: Date.now() + 3600000,
      },
    ]
  );
  await f.admin.query("update run set state='running' where id=$1", [f.run]);
  const authority = new CapabilityAuthority(
    f.db,
    new CapabilitySigner(generateKeyPairSync("ed25519").privateKey)
  );
  const mcp = await authority.issue(f.account, f.run),
    model = await authority.issueModel(f.account, f.run, mcp);
  return { ...f, authority, mcp, model };
}
const body = (text = "fixture") => ({
  model: "deepseek-flash",
  stream: true,
  thinking: { type: "disabled" },
  max_tokens: 256,
  messages: [{ role: "user", content: text }],
});
const sse = () =>
  new Response(
    "data: " +
      JSON.stringify({
        model: "deepseek-flash",
        choices: [
          {
            index: 0,
            delta: { content: "fixture only" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }) +
      "\n\ndata: [DONE]\n\n"
  );
function send(app: any, token: string, input: any) {
  return app.request("http://localhost/mcp/clarify-model", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}
it("model and MCP tokens have separate audiences and shared online revocation; no authorization means zero forwarding", async () => {
  const f = await fixture();
  try {
    await expect(f.authority.validate(f.model)).rejects.toBeDefined();
    await expect(f.authority.validateModel(f.mcp)).rejects.toBeDefined();
    const app = new Hono();
    registerClarifyModel(app as any, f.authority);
    expect((await send(app, f.model, body())).status).toBe(503);
    expect(
      (
        await f.admin.query(
          "select * from clarify_model_request where account_id=$1",
          [f.account]
        )
      ).rowCount
    ).toBe(0);
    await f.authority.revoke(f.account, f.run);
    await expect(f.authority.validateModel(f.model)).rejects.toBeDefined();
  } finally {
    await f.close();
  }
});
it("every actual model HTTP request reserves durable worst-case cost; parallel/replayed bodies cannot exceed six rounds or the run cap", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const app = new Hono();
    registerClarifyModel(app as any, f.authority, {
      async prepare() {
        return async () => {
          calls++;
          return sse();
        };
      },
    });
    const answers = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        send(app, f.model, body("unique " + i))
      )
    );
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(6);
    expect(answers.filter((r: any) => r.status === 200)).toHaveLength(calls);
    const sum = (
      await f.admin.query(
        "select count(*)::int n,sum(case when state='completed' then (response_receipt->>'costUpperMicros')::int else maximum_micros end)::int total from clarify_model_request where account_id=$1",
        [f.account]
      )
    ).rows[0];
    expect(sum.n).toBe(calls);
    expect(sum.total).toBeLessThanOrEqual(500000);
    const before = calls;
    await send(app, f.model, body("unique 0"));
    expect(calls).toBe(before);
    // One admitted request can no longer exceed the run cap, so the aggregate guard is the bound.
    expect(modelMaximum(65536, 512)).toBeLessThan(500000);
    expect(6 * modelMaximum(65536, 512)).toBeGreaterThan(500000);
  } finally {
    await f.close();
  }
});
it("lost usage closes the durable gate, retains unknown hold and never retries; images and wrong thinking fail before forwarding", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const app = new Hono();
    registerClarifyModel(app as any, f.authority, {
      async prepare() {
        return async () => {
          calls++;
          return new Response("data: [DONE]\n\n");
        };
      },
    });
    for (const invalid of [
      {...body(),enable_search:true},
      {...body(),web_search_options:{}},
      { ...body(), thinking: undefined },
      { ...body(), max_tokens: 257 },
      {
        ...body(),
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "x" } }],
          },
        ],
      },
    ])
      expect((await send(app, f.model, invalid)).status).toBe(409);
    expect(calls).toBe(0);
    expect((await send(app, f.model, body())).status).toBe(409);
    expect(calls).toBe(1);
    await send(app, f.model, body("again"));
    expect(calls).toBe(1);
    expect(
      (
        await f.admin.query("select state from budget_hold where id=$1", [
          f.hold,
        ])
      ).rows[0].state
    ).toBe("unpriced");
    expect(
      (
        await f.admin.query(
          "select state from clarify_model_request where account_id=$1",
          [f.account]
        )
      ).rows[0].state
    ).toBe("unknown");
  } finally {
    await f.close();
  }
});
it("cross-frame credentials and reordered tool-call arguments are blocked after index-based reconstruction", () => {
  const key = "fixture-secret-" + randomUUID();
  const frames = [key.slice(0, 12), key.slice(12)]
    .map(
      (part, i) =>
        "data: " +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 4, function: { arguments: part } }],
              },
            },
          ],
        }) +
        "\n\n"
    )
    .join("");
  expect(reflectsCredential(frames, [key])).toBe(true);
  expect(
    reflectsCredential(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: { content: "safe" } }],
        }) +
        "\n\ndata: [DONE]\n\n",
      [key]
    )
  ).toBe(false);
});
it("incomplete finish and usage exceeding the admitted bound remain unknown and block the next model call", async () => {
  for (const completion of [257, -1]) {
    const f = await fixture();
    try {
      let calls = 0;
      const app = new Hono();
      registerClarifyModel(app as any, f.authority, {
        async prepare() {
          return async () => {
            calls++;
            return new Response(
              "data: " +
                JSON.stringify({
                  choices: [
                    {
                      index: 0,
                      delta: { content: "partial" },
                      finish_reason: null,
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: completion },
                }) +
                "\n\ndata: [DONE]\n\n"
            );
          };
        },
      });
      expect((await send(app, f.model, body())).status).toBe(409);
      await send(app, f.model, body("next"));
      expect(calls).toBe(1);
    } finally {
      await f.close();
    }
  }
});
