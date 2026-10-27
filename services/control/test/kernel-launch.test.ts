import { describe, expect, it, vi } from "vitest";
import { launchPlan, materializeLaunch } from "../src/kernel/dsh/launch";

const base = {
  account: "10000000-0000-4000-8000-000000000001",
  controlUrl: "http://host.docker.internal:3001",
  model: "deepseek-v4-flash",
  maxTokens: 32768,
  bundler: {
    shimModule: "/app/reinlab/shim.mjs",
    pluginPatch: "/opt/reinlab/patches/read-plugin.patch.yml",
    restrictPatch: "/opt/reinlab/patches/read-restrict.patch.yml",
  },
};

describe("dsh launch plan", () => {
  it("scopes every run-owned file to the run, never to the account", () => {
    const one = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000001", dossier: "20000000-0000-4000-8000-000000000001", sessionId: "ses_a" });
    const two = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000002", dossier: "20000000-0000-4000-8000-000000000002", sessionId: "ses_b" });
    for (const key of ["runDir", "pidFile", "tokenFile", "patchFile", "credentialsFile"] as const) {
      expect(one.paths[key]).not.toBe(two.paths[key]);
      expect(one.paths[key]).toContain(one.run);
      expect(two.paths[key]).toContain(two.run);
    }
    // The shared home is per account, which is the isolation boundary.
    expect(one.options.dshHome).toBe(two.options.dshHome);
    expect(one.options.dshHome).toContain(base.account);
  });

  it("launches the container shim with no provider key in the child environment", () => {
    const plan = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000003", dossier: "20000000-0000-4000-8000-000000000003", sessionId: "ses_c" });
    expect(plan.options.dshBin).toBe(base.bundler.shimModule);
    expect(plan.options.profile).toBe("sdk");
    expect(plan.options.provider).toBe("deepseek-official");
    expect(plan.options.model).toBe(base.model);
    expect(plan.options.maxTokens).toBe(base.maxTokens);
    expect(plan.options.patches).toContain(base.bundler.restrictPatch);
    expect(plan.options.cwd).toContain(base.account);
    const names = Object.keys(plan.options.env);
    expect(names.some((name) => /_KEY$|_SECRET$|_PASSWORD$/.test(name))).toBe(false);
    expect(plan.options.env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(plan.options.env.SHIM_CONTAINER).toBeTruthy();
    expect(plan.options.env.SHIM_RUN_ID).toBe(plan.run);
    // The provider base URL is the control plane, never the provider itself.
    expect(plan.options.env.DEEPSEEK_BASE_URL).toBe(base.controlUrl + "/llm/anthropic");
  });

  it("writes run files through the injected writer and removes them on release", async () => {
    const writes = new Map<string, string>();
    const removed: string[] = [];
    const io = {
      write: async (path: string, body: string) => void writes.set(path, body),
      remove: async (path: string) => void removed.push(path),
      mkdir: async () => {},
    };
    const plan = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000004", dossier: "20000000-0000-4000-8000-000000000004", sessionId: "ses_d" });
    await materializeLaunch(plan, "tok_live", io);
    expect([...writes.keys()].sort()).toEqual([plan.paths.credentialsFile, plan.paths.patchFile].sort());
    expect(writes.get(plan.paths.credentialsFile)).toContain("tok_live");
    expect(writes.get(plan.paths.patchFile)).toContain(plan.paths.pidFile);
    await plan.release();
    expect(removed.sort()).toEqual([plan.paths.credentialsFile, plan.paths.patchFile, plan.paths.pidFile].sort());
  });

  it("refuses a plan whose control URL or model is missing", () => {
    expect(() => launchPlan({ ...base, controlUrl: "", run: "30000000-0000-4000-8000-000000000005", dossier: "20000000-0000-4000-8000-000000000005", sessionId: "s" })).toThrow();
    expect(() => launchPlan({ ...base, model: "", run: "30000000-0000-4000-8000-000000000006", dossier: "20000000-0000-4000-8000-000000000006", sessionId: "s" })).toThrow();
  });
});
