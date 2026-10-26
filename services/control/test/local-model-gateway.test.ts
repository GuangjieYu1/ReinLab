import { it, expect, vi } from "vitest";
import { Hono } from "hono";
import { randomUUID, generateKeyPairSync } from "node:crypto";
import { mcpFixture } from "./mcp-fixture";
import { CapabilityAuthority } from "../src/mcp/authority";
import { CapabilitySigner } from "../src/mcp/token";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import { materializeHarnessRole } from "../src/harness/materialize";
import { loadToolRegistry } from "../src/harness/manifest";
import { localPeakPricing } from "../src/model/peak-pricing";
import { modelMaximum } from "../src/clarify/model";
import { registerRuntimeModel } from "../src/model/gateway";
const request = (text = "fixture") => ({
  model: "deepseek-flash",
  stream: true,
  thinking: { type: "disabled" },
  max_tokens: 1024,
  messages: [{ role: "user", content: text }],
});
const complete = () =>
  new Response(
    'data: {"model":"deepseek-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    { headers: { "content-type": "text/event-stream" } },
  );
async function setup(clarify=false,version="1.2.0") {
  const f = await mcpFixture(undefined, false, version, clarify ? "research-clarify" : "research-read");
  if(clarify){await f.admin.query("insert into read_clarification(account_id,dossier_id)values($1,$2)",[f.account,f.dossier]);await f.admin.query("insert into read_clarify_run(account_id,dossier_id,run_id)values($1,$2,$3)",[f.account,f.dossier,f.run]);}
  await f.admin.query("update run set state='queued' where id=$1", [f.run]);
  const role = materializeHarnessRole(f.effective, await loadToolRegistry(), {
    dossierId: f.dossier,
    roleId: clarify ? "research-clarify" : "research-read",
    modelRoutes: { cheap:"deepseek/deepseek-v4-flash", strong: "deepseek/deepseek-v4-flash" },
    memory: "",
  });
  await new BindingStore(f.db).prepare(f.account, f.run, {
    role,
    message: "fixture",
  });
  await f.admin.query(
    "update os_binding set hold_id=$2,pricing_context=$3 where run_id=$1",
    [f.run, f.hold, localPeakPricing()],
  );
  await f.admin.query("update run set state='running' where id=$1", [f.run]);
  const authority = new CapabilityAuthority(
      f.db,
      new CapabilitySigner(generateKeyPairSync("ed25519").privateKey),
    ),
    mcp = await authority.issue(f.account, f.run),
    model = await authority.issueRuntimeModel(f.account, f.run, mcp);
  return { ...f, authority, mcp, model };
}
const send = (app: any, token: string, body: any) =>
  app.request("http://localhost/mcp/runtime-model", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
it("default disabled and MCP audience both forward zero requests", async () => {
  const f = await setup();
  try {
    const app = new Hono();
    registerRuntimeModel(app as never, f.authority);
    expect((await send(app, f.model, request())).status).toBe(503);
    expect((await send(app, f.mcp, request())).status).not.toBe(200);
    expect(
      (
        await f.admin.query(
          "select 1 from runtime_model_request where run_id=$1",
          [f.run],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
it("commits a worst case reservation within this hold before actual transport and releases only known excess", async () => {
  const f = await setup();
  let forwards = 0;
  try {
    const app = new Hono();
    registerRuntimeModel(app as never, f.authority, {
      prepare: async () => async () => {
        forwards++;
        const r = (
          await f.admin.query(
            "select state,maximum_micros from runtime_model_request where run_id=$1",
            [f.run],
          )
        ).rows;
        expect(r).toHaveLength(1);
        expect(r[0].state).toBe("forwarding");
        expect(Number(r[0].maximum_micros)).toBeGreaterThan(0);
        return complete();
      },
    });
    expect((await send(app, f.model, request())).status).toBe(200);
    expect((await send(app, f.model, request())).status).not.toBe(200);
    expect(forwards).toBe(1);
    const row = (
      await f.admin.query(
        "select state,response_receipt from runtime_model_request where run_id=$1",
        [f.run],
      )
    ).rows[0];
    expect(row.state).toBe("completed");
    expect(row.response_receipt.costUpperMicros).toBe(11);
  } finally {
    await f.close();
  }
});
it("a smaller confirmed hold cannot be bypassed by a valid token or a different request body", async () => {
  const f = await setup();
  let forwards = 0;
  try {
    await f.admin.query("update budget_hold set maximum_cny=.001 where id=$1", [
      f.hold,
    ]);
    const app = new Hono();
    registerRuntimeModel(app as never, f.authority, {
      prepare: async () => async () => {
        forwards++;
        return complete();
      },
    });
    for (const text of ["first", "another"])
      expect((await send(app, f.model, request(text))).status).not.toBe(200);
    expect(forwards).toBe(0);
  } finally {
    await f.close();
  }
});
it("unknown upstream marks hold unpriced, retains reservation and fences a replacement gateway", async () => {
  const f = await setup();
  let forwards = 0;
  try {
    for (let i = 0; i < 2; i++) {
      const app = new Hono();
      registerRuntimeModel(app as never, f.authority, {
        prepare: async () => async () => {
          forwards++;
          throw Error("synthetic transport unknown");
        },
      });
      expect((await send(app, f.model, request("round" + i))).status).not.toBe(
        200,
      );
    }
    expect(forwards).toBe(1);
    expect(
      (
        await f.admin.query("select state from budget_hold where id=$1", [
          f.hold,
        ])
      ).rows[0].state,
    ).toBe("unpriced");
    expect(
      (
        await f.admin.query(
          "select state from runtime_model_request where run_id=$1",
          [f.run],
        )
      ).rows[0].state,
    ).toBe("unknown");
  } finally {
    await f.close();
  }
});

const body = request;
const frame = (usage = {prompt_tokens:1,completion_tokens:1},extra = {}) => ({model:"deepseek-flash",choices:[{index:0,delta:{},finish_reason:"stop"}],usage,...extra});
const response = (values:unknown[]) => new Response(values.map(v=>"data: "+JSON.stringify(v)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
it("SQL independently binds hold/account, checks exact maximum, serializes claims and freezes usage proofs", async () => {
  const f = await setup(),
    other = await setup(),
    maximum = modelMaximum(1000, 1024);
  const insert = (hash: string, hold = f.hold, max = maximum) =>
    f.db.withAccount(f.account, (c) =>
      c.query(
        "insert into runtime_model_request(account_id,dossier_id,run_id,hold_id,body_hash,wire_bytes,max_output,maximum_micros,state)values($1,$2,$3,$4,$5,1000,1024,$6,'forwarding')",
        [f.account, f.dossier, f.run, hold, hash, max],
      ),
    );
  try {
    await expect(insert("a".repeat(64), other.hold)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert("a".repeat(64), f.hold, 1)).rejects.toMatchObject({
      code: "23514",
    });
    const claims = await Promise.allSettled([
      insert("b".repeat(64)),
      insert("c".repeat(64)),
    ]);
    expect(claims.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    expect(
      (
        await other.db.withAccount(other.account, (c) =>
          c.query("select 1 from runtime_model_request where account_id=$1", [
            f.account,
          ]),
        )
      ).rowCount,
    ).toBe(0);
    const proof = {
      promptTokens: 1,
      completionTokens: 1,
      costUpperMicros: 11,
      observedAt: Date.now(),
      responseSha256: "f".repeat(64),
      responseModel: "deepseek-flash",
      pricingVersion: "deepseek-official-2026-10-20",
    };
    const invalidProofs: unknown[] = [
      { ...proof, costUpperMicros: 1 },
      { ...proof, promptTokens: "1" },
      { ...proof, promptTokens: 5097 },
      { ...proof, completionTokens: 1025 },
      { ...proof, observedAt: "1" },
      { ...proof, responseModel: "unpriced" },
      {},
    ];
    for (const key of Object.keys(proof)) {
      const missing: Record<string, unknown> = { ...proof };
      delete missing[key];
      invalidProofs.push(missing);
    }
    for (const invalid of invalidProofs)
      await expect(
        f.db.withAccount(f.account, (c) =>
          c.query(
            "update runtime_model_request set state='completed',response_receipt=$2 where run_id=$1",
            [f.run, invalid],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514" });
    await f.db.withAccount(f.account, (c) =>
      c.query(
        "update runtime_model_request set state='completed',response_receipt=$2 where run_id=$1",
        [f.run, proof],
      ),
    );
    await expect(
      f.db.withAccount(f.account, (c) =>
        c.query(
          "update runtime_model_request set response_receipt=$2 where run_id=$1",
          [f.run, { ...proof, costUpperMicros: 1 }],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      f.db.withAccount(f.account, (c) =>
        c.query("delete from runtime_model_request where run_id=$1", [f.run]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await other.close();
    await f.close();
  }
});
it.each(["split-credential", "changed-usage"])(
  "unsafe SSE %s retains the maximum and fences a fresh gateway",
  async (mode) => {
    const f = await setup();
    let forwards = 0;
    try {
      const parts =
        mode === "split-credential"
          ? [
              frame(undefined, {
                choices: [
                  {
                    index: 0,
                    delta: { content: f.model.slice(0, 30) },
                    finish_reason: null,
                  },
                ],
              }),
              frame(undefined, {
                choices: [
                  {
                    index: 0,
                    delta: { content: f.model.slice(30) },
                    finish_reason: "stop",
                  },
                ],
              }),
            ]
          : [frame(), frame({ prompt_tokens: 2, completion_tokens: 1 })];
      for (let i = 0; i < 2; i++) {
        const app = new Hono();
        registerRuntimeModel(app as never, f.authority, {
          prepare: async () => async () => {
            forwards++;
            return response(parts);
          },
        });
        const result = await send(app, f.model, request("fixture" + i));
        expect(result.status).not.toBe(200);
        expect(await result.text()).not.toContain(f.model);
      }
      expect(forwards).toBe(1);
      expect(
        (
          await f.admin.query(
            "select state,response_receipt from runtime_model_request where run_id=$1",
            [f.run],
          )
        ).rows[0],
      ).toEqual({ state: "unknown", response_receipt: null });
      expect(
        (
          await f.admin.query("select state from budget_hold where id=$1", [
            f.hold,
          ])
        ).rows[0].state,
      ).toBe("unpriced");
    } finally {
      await f.close();
    }
  },
);

it("unapproved paid options, model, tool and output shapes cannot create a reservation or upstream request", async () => {
  const f = await setup(),
    transport = vi.fn(async () => response([frame()]));
  try {
    const app = new Hono();
    registerRuntimeModel(app as never, f.authority, {
      prepare: async () => transport,
    });
    for (const patch of [
      { enable_search: true },
      { web_search_options: {} },
      { model: "unpriced-model" },
      { max_tokens: 1025 },
      { n: 2 },
      { tools: [{ type: "function", function: { name: "ungranted_tool" } }] },
      {
        messages: [
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: "fixture" } }],
          },
        ],
      },
    ]) {
      const result = await app.request("http://localhost/mcp/runtime-model", {
        method: "POST",
        headers: {
          authorization: "Bearer " + f.model,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request(), ...patch }),
      });
      expect(result.status).not.toBe(200);
    }
    expect(transport).not.toHaveBeenCalled();
    expect(
      (
        await f.admin.query(
          "select 1 from runtime_model_request where run_id=$1",
          [f.run],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await f.close();
  }
});


it("research1.2.1 admits 512 output tokens while preserving the .05 run ceiling",async()=>{
 const f=await setup(true,"1.2.1");let forwarded=0;
 try{const app=new Hono();registerRuntimeModel(app as never,f.authority,{prepare:async()=>async()=>{forwarded++;return complete();}});
 expect((await send(app,f.model,{...request(),max_tokens:512})).status).toBe(200);
 const row=(await f.admin.query("select max_output from clarify_model_request where run_id=$1",[f.run])).rows[0];expect(row.max_output).toBe(512);
 expect((await send(app,f.model,{...request("over cap"),max_tokens:513})).status).not.toBe(200);expect(forwarded).toBe(1);
 }finally{await f.close();}
});
