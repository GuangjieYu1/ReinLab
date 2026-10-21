import { beforeAll, afterAll, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { BindingStore } from "../src/bridge/openscience/binding-store";
import {
  DecisionService,
  type DecisionRuntimePort,
} from "../src/bridge/openscience/decisions";
const admin = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres@127.0.0.1:55432/reinlab_test",
});
const pool = new pg.Pool({
  connectionString:
    process.env.TEST_DATABASE_URL_APP ??
    "postgres://reinlab_app@127.0.0.1:55432/reinlab_test",
  max: 6,
});
const db = new Database(pool),
  bindings = new BindingStore(db);
beforeAll(async () => {
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  await db.assertSafeRole();
}, 30000);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
async function fixture(kind: "permission" | "question" = "permission") {
  const account = randomUUID(),
    dossier = randomUUID(),
    run = randomUUID(),
    approval = randomUUID(),
    request = "req_" + randomUUID();
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query(
    "insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','decisions',$3)",
    [dossier, account, "/data/dossiers/" + dossier],
  );
  await admin.query(
    "insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'queued',1)",
    [run, account, dossier, randomUUID()],
  );
  const b = await bindings.prepare(account, run, {
    role: {
      dossierId: dossier,
      role: {
        id: "research-read",
        prompt: "fixture",
        toolGrants: {
          read: { risk: "read", permission: "ask" },
          dangerous: { risk: "danger", permission: "ask" },
        },
        writeTargets: [],
        steps: 1,
      },
      memory: "",
      model: "deepseek/deepseek-v4-flash",
    },
    message: "fixture",
  });
  await admin.query(
    "update os_binding set phase='accepted',receipt=$2 where run_id=$1",
    [run, { runID: "runtime_" + run, acceptedAt: 1 }],
  );
  await admin.query("update run set state='running' where id=$1", [run]);
  await db.withAccount(account, (c) =>
    c.query(
      "insert into approval(id,account_id,run_id,os_request_id,os_session_id,kind,title,effects,risk) values($1,$2,$3,$4,$5,$6,'fixture','[]','write')",
      [approval, account, run, request, b.sessionId, kind],
    ),
  );
  const permission = {
    id: request,
    sessionID: b.sessionId,
    permission: "read",
    patterns: [],
    metadata: {},
    always: [],
  };
  const question = {
    id: request,
    sessionID: b.sessionId,
    questions: [
      {
        question: "pick",
        header: "pick",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiple: false,
        custom: false,
      },
    ],
  };
  const current = {
    sessionID: b.sessionId,
    runs: [
      {
        runID: "runtime_" + run,
        sessionID: b.sessionId,
        requestID: b.requestId,
        messageID: "msg_fixture",
        state: "running" as const,
        acceptedAt: 1,
        updatedAt: 1,
      },
    ],
    oldestSequence: 0,
    latestSequence: 0,
    permissions: kind === "permission" ? [permission] : [],
    questions: kind === "question" ? [question] : [],
    decisionScope: "connected_runtime" as const,
  };
  const runtime = {
    snapshot: vi.fn(async () => current),
    decide: vi.fn(async () => ({
      sessionID: b.sessionId,
      requestID: request,
      status: "resolved" as const,
      decidedAt: 1,
    })),
    cancel: vi.fn(async () => ({
      ...current.runs[0],
      state: "cancelled" as const,
    })),
  } satisfies DecisionRuntimePort;
  const access = { runtime: vi.fn(async () => runtime) },
    service = new DecisionService(db, access);
  const prepare = (input: unknown) =>
    db.withAccount(account, (c) =>
      service.prepare(c, account, approval, input),
    );
  const row = async () =>
    (await admin.query("select * from approval where id=$1", [approval]))
      .rows[0];
  return {
    account,
    dossier,
    run,
    approval,
    request,
    binding: b,
    current,
    runtime,
    access,
    service,
    prepare,
    row,
  };
}
it("prepare persists intent without contacting runtime and rolls back with its transaction", async () => {
  const f = await fixture();
  const receipt = await f.prepare({ decision: "approve" });
  expect(receipt.status).toBe("prepared");
  expect(f.access.runtime).not.toHaveBeenCalled();
  expect((await f.row()).decision_sent).toBe(false);
  expect(await f.prepare({ decision: "approve", scope: "once" })).toEqual(
    receipt,
  );
  await expect(f.prepare({ decision: "reject" })).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  const other = await fixture();
  await expect(
    db.withAccount(other.account, async (c) => {
      await other.service.prepare(c, other.account, other.approval, {
        decision: "approve",
      });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  expect((await other.row()).decision_hash).toBeNull();
});
it.each(["once", "session"] as const)(
  "permission %s is sent only after committed CAS and resolves from explicit intent",
  async (scope) => {
    const f = await fixture();
    await f.prepare({ decision: "approve", scope });
    f.runtime.decide.mockImplementationOnce(async () => {
      expect((await f.row()).decision_sent).toBe(true);
      expect((await f.row()).state).toBe("indeterminate");
      return {
        sessionID: f.binding.sessionId,
        requestID: f.request,
        status: "resolved",
        decidedAt: 1,
      };
    });
    const receipts = await Promise.all([
      f.service.dispatch(f.account, f.approval),
      f.service.dispatch(f.account, f.approval),
    ]);
    expect(receipts.some((r) => r.status === "resolved")).toBe(true);
    expect(f.runtime.decide).toHaveBeenCalledTimes(1);
    expect(f.runtime.decide).toHaveBeenCalledWith({
      kind: "permission",
      sessionID: f.binding.sessionId,
      requestID: f.request,
      reply: scope,
    });
    expect((await f.row()).state).toBe("approved");
    expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
      "resolved",
    );
  },
);
it("permission reject is explicit and never grants a session", async () => {
  const f = await fixture();
  await f.prepare({ decision: "reject" });
  await f.service.dispatch(f.account, f.approval);
  expect(f.runtime.decide).toHaveBeenCalledWith({
    kind: "permission",
    sessionID: f.binding.sessionId,
    requestID: f.request,
    reply: "reject",
  });
  expect((await f.row()).state).toBe("rejected");
});
it.each([
  { decision: "approve", answers: [] },
  { decision: "approve", scope: "always" },
  { decision: "approve", scope: "project" },
  { decision: "approve", extra: true },
])("strict permission input rejects %j before dispatch", async (input) => {
  const f = await fixture();
  await expect(f.prepare(input)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  expect((await f.row()).decision_hash).toBeNull();
  expect(f.access.runtime).not.toHaveBeenCalled();
});
it.each(["dangerous", "unknown-tool"])(
  "untrusted/danger permission %s cannot be approved",
  async (permission) => {
    const f = await fixture();
    f.current.permissions[0].permission = permission;
    await f.prepare({ decision: "approve" });
    await expect(
      f.service.dispatch(f.account, f.approval),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect((await f.row()).decision_sent).toBe(false);
    expect(f.runtime.decide).not.toHaveBeenCalled();
  },
);
it("question answer success uses fresh request and exact original session identity", async () => {
  const f = await fixture("question");
  await f.prepare({ decision: "approve", answers: [["A"]] });
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "resolved",
  );
  expect(f.runtime.decide).toHaveBeenCalledWith({
    kind: "question",
    sessionID: f.binding.sessionId,
    requestID: f.request,
    answers: [["A"]],
  });
});
it.each([
  { answers: [["unknown"]] },
  { answers: [["A", "B"]] },
  { answers: [["A", "A"]] },
  { answers: [["A"], ["B"]] },
])(
  "fresh question requirements reject %j with 400 and unsent fence",
  async ({ answers }) => {
    const f = await fixture("question");
    await f.prepare({ decision: "approve", answers });
    await expect(
      f.service.dispatch(f.account, f.approval),
    ).rejects.toMatchObject({ code: "INVALID_ANSWER", status: 400 });
    expect((await f.row()).decision_sent).toBe(false);
    expect(f.runtime.decide).not.toHaveBeenCalled();
  },
);
it("question session scope and missing answers reject before saving an intent", async () => {
  const f = await fixture("question");
  for (const input of [
    { decision: "approve", scope: "session", answers: [["A"]] },
    { decision: "approve" },
  ])
    await expect(f.prepare(input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  await f.prepare({ decision: "reject" });
  await f.service.dispatch(f.account, f.approval);
  expect(f.runtime.decide).toHaveBeenCalledWith({
    kind: "question_reject",
    sessionID: f.binding.sessionId,
    requestID: f.request,
  });
});
it("multiple and custom question options are checked according to current snapshot", async () => {
  const f = await fixture("question");
  f.current.questions[0].questions[0].multiple = true;
  f.current.questions[0].questions[0].custom = true;
  await f.prepare({ decision: "approve", answers: [["A", "free answer"]] });
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "resolved",
  );
});
it.each(["throw", "indeterminate"] as const)(
  "uncertain %s delivery is never resent by a restarted service",
  async (outcome) => {
    const f = await fixture();
    await f.prepare({ decision: "approve" });
    if (outcome === "throw")
      f.runtime.decide.mockRejectedValueOnce(
        new Error("fixture private error text"),
      );
    else
      f.runtime.decide.mockResolvedValueOnce({
        sessionID: f.binding.sessionId,
        requestID: f.request,
        status: "indeterminate" as "resolved",
        decidedAt: 1,
      });
    expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
      "indeterminate",
    );
    const restarted = new DecisionService(db, f.access);
    expect((await restarted.dispatch(f.account, f.approval)).status).toBe(
      "indeterminate",
    );
    expect(f.runtime.decide).toHaveBeenCalledTimes(1);
    f.current.permissions = [];
    expect((await restarted.dispatch(f.account, f.approval)).status).toBe(
      "expired",
    );
    expect((await f.row()).state).toBe("expired");
    expect(
      (await admin.query("select state from run where id=$1", [f.run])).rows[0]
        .state,
    ).toBe("interrupted");
    expect(JSON.stringify((await f.row()).decision_receipt)).not.toContain(
      "private error",
    );
  },
);
it("a gone fresh pending request expires unsent intent without any SDK decision", async () => {
  const f = await fixture();
  await f.prepare({ decision: "approve" });
  f.current.permissions = [];
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "expired",
  );
  expect(f.runtime.decide).not.toHaveBeenCalled();
  expect((await f.row()).decision_sent).toBe(false);
});
it("cross-tenant preparation/list/dispatch and wrong snapshot binding are rejected", async () => {
  const f = await fixture(),
    foreign = await fixture();
  await f.prepare({ decision: "approve" });
  await expect(
    db.withAccount(foreign.account, (c) =>
      f.service.prepare(c, foreign.account, f.approval, {
        decision: "approve",
      }),
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    f.service.dispatch(foreign.account, f.approval),
  ).rejects.toMatchObject({ status: 404 });
  expect(
    (await f.service.listPending(foreign.account)).some(
      (x: any) => x.id === f.approval,
    ),
  ).toBe(false);
  f.current.runs[0].requestID = "foreign_request";
  await expect(f.service.dispatch(f.account, f.approval)).rejects.toMatchObject(
    { code: "SCOPE_DENIED" },
  );
  expect(f.runtime.decide).not.toHaveBeenCalled();
});
it("list includes only decision approvals with matched binding and safe DTOs", async () => {
  const f = await fixture();
  await f.prepare({ decision: "approve" });
  await f.service.dispatch(f.account, f.approval);
  await admin.query(
    "insert into approval(account_id,run_id,kind,title,effects,risk) values($1,$2,'budget','budget','[]','write')",
    [f.account, f.run],
  );
  expect(await f.service.listPending(f.account)).toEqual([]);
  await admin.query("update approval set state='indeterminate' where id=$1", [
    f.approval,
  ]);
  const rows = await f.service.listPending(f.account);
  expect(rows).toHaveLength(1);
  expect(rows[0]).not.toHaveProperty("decision_input");
  expect(rows[0]).not.toHaveProperty("decision_hash");
});
it("cancel only uses persisted runtime identity and uncertainty is not resent", async () => {
  const f = await fixture();
  f.runtime.cancel.mockRejectedValueOnce(new Error("fixture cancel error"));
  expect((await f.service.cancel(f.account, f.run)).status).toBe(
    "indeterminate",
  );
  expect(f.runtime.cancel).toHaveBeenCalledWith(
    f.binding.sessionId,
    "runtime_" + f.run,
  );
  expect(
    (await new DecisionService(db, f.access).cancel(f.account, f.run)).status,
  ).toBe("indeterminate");
  expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
  f.current.runs[0].state = "cancelled" as "running";
  expect((await f.service.cancel(f.account, f.run)).status).toBe("resolved");
});
it("migration prevents reversing a sent fence or rewriting prepared intent", async () => {
  const f = await fixture();
  await f.prepare({ decision: "approve" });
  await f.service.dispatch(f.account, f.approval);
  await expect(
    db.withAccount(f.account, (c) =>
      c.query("update approval set decision_sent=false where id=$1", [
        f.approval,
      ]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.withAccount(f.account, (c) =>
      c.query("update approval set decision_input='{}' where id=$1", [
        f.approval,
      ]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("wrong approval session and non-decision kinds cannot be prepared or dispatched", async () => {
  const f = await fixture();
  await admin.query(
    "update approval set os_session_id='foreign_session' where id=$1",
    [f.approval],
  );
  await expect(f.prepare({ decision: "approve" })).rejects.toMatchObject({
    status: 404,
  });
  expect(await f.service.listPending(f.account)).toEqual([]);
  await admin.query(
    "update approval set os_session_id=$2,kind='budget' where id=$1",
    [f.approval, f.binding.sessionId],
  );
  await expect(f.prepare({ decision: "approve" })).rejects.toMatchObject({
    status: 404,
  });
  await expect(f.service.dispatch(f.account, f.approval)).rejects.toMatchObject(
    { status: 404 },
  );
  expect(f.access.runtime).not.toHaveBeenCalled();
});
it("bounded empty or oversized answers reject before intent is stored", async () => {
  const f = await fixture("question");
  for (const answers of [
    [],
    [[]],
    [["x".repeat(4001)]],
    Array.from({ length: 65 }, () => ["A"]),
  ])
    await expect(
      f.prepare({ decision: "approve", answers }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", status: 400 });
  expect((await f.row()).decision_hash).toBeNull();
  expect(f.access.runtime).not.toHaveBeenCalled();
});
it("read-only snapshot failure leaves an unsent intent eligible for later fresh verification", async () => {
  const f = await fixture();
  await f.prepare({ decision: "approve" });
  f.runtime.snapshot.mockRejectedValueOnce(
    new Error("fixture snapshot failure"),
  );
  await expect(f.service.dispatch(f.account, f.approval)).rejects.toMatchObject(
    { code: "OS_UNAVAILABLE", status: 503 },
  );
  expect((await f.row()).decision_sent).toBe(false);
  expect(f.runtime.decide).not.toHaveBeenCalled();
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "resolved",
  );
});
it("a resolved SDK response for another request cannot mark this approval approved", async () => {
  const f = await fixture();
  await f.prepare({ decision: "approve" });
  f.runtime.decide.mockResolvedValueOnce({
    sessionID: f.binding.sessionId,
    requestID: "foreign_request",
    status: "resolved",
    decidedAt: 1,
  });
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "indeterminate",
  );
  expect((await f.row()).state).toBe("indeterminate");
});
it("concurrent cancellation commits a one-way send fence before the only SDK call", async () => {
  const f = await fixture();
  f.runtime.cancel.mockImplementationOnce(async () => {
    expect(
      (
        await admin.query(
          "select cancel_sent from os_binding where run_id=$1",
          [f.run],
        )
      ).rows[0].cancel_sent,
    ).toBe(true);
    return { ...f.current.runs[0], state: "cancelled" };
  });
  const receipts = await Promise.all([
    f.service.cancel(f.account, f.run),
    f.service.cancel(f.account, f.run),
  ]);
  expect(receipts.some((r) => r.status === "resolved")).toBe(true);
  expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
  await expect(
    db.withAccount(f.account, (c) =>
      c.query("update os_binding set cancel_sent=false where run_id=$1", [
        f.run,
      ]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("danger permission can still be explicitly rejected without granting it", async () => {
  const f = await fixture();
  f.current.permissions[0].permission = "dangerous";
  await f.prepare({ decision: "reject" });
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "resolved",
  );
  expect(f.runtime.decide).toHaveBeenCalledWith({
    kind: "permission",
    sessionID: f.binding.sessionId,
    requestID: f.request,
    reply: "reject",
  });
});
it("preflight invalid answer leaves no intent and allows a corrected answer through the full API ordering", async () => {
  const f = await fixture("question");
  await expect(
    f.service.validate(f.account, f.approval, {
      decision: "approve",
      answers: [["unknown"]],
    }),
  ).rejects.toMatchObject({ code: "INVALID_ANSWER", status: 400 });
  expect((await f.row()).decision_hash).toBeNull();
  expect((await f.row()).decision_sent).toBe(false);
  expect(f.runtime.decide).not.toHaveBeenCalled();
  const corrected = { decision: "approve", answers: [["A"]] };
  await f.service.validate(f.account, f.approval, corrected);
  await f.prepare(corrected);
  expect((await f.service.dispatch(f.account, f.approval)).status).toBe(
    "resolved",
  );
});
it("same-intent preflight retries keep the original resolved receipt after native pending disappears", async () => {
  const f = await fixture();
  const input = { decision: "approve" };
  await f.service.validate(f.account, f.approval, input);
  await f.prepare(input);
  const receipt = await f.service.dispatch(f.account, f.approval);
  f.current.permissions = [];
  await f.service.validate(f.account, f.approval, input);
  expect(await f.prepare(input)).toEqual(receipt);
  expect(await f.service.dispatch(f.account, f.approval)).toEqual(receipt);
  await expect(
    f.service.validate(f.account, f.approval, { decision: "reject" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(f.runtime.decide).toHaveBeenCalledTimes(1);
});
