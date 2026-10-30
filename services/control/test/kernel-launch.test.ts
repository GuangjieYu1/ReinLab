import { describe, expect, it, vi } from "vitest";
import { launchPlan, materializeLaunch } from "../src/kernel/dsh/launch";

const base = {
  account: "10000000-0000-4000-8000-000000000001",
  controlUrl: "http://host.docker.internal:3001",
  model: "deepseek-v4-flash",
  maxTokens: 32768,
  bundler: {
    shimModule: "/app/reinlab/shim.mjs",
    pluginEntry: "file:///opt/reinlab/plugin/index.js",
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
    expect([...writes.keys()].sort()).toEqual(
      [plan.paths.credentialsFile, plan.paths.tokenFile, plan.paths.patchFile].sort(),
    );
    expect(writes.get(plan.paths.credentialsFile)).toContain("version: 1");
    expect(writes.get(plan.paths.credentialsFile)).toContain("tok_live");
    expect(writes.get(plan.paths.patchFile)).toContain(plan.paths.credentialsFile);
    await plan.release();
    expect(removed.sort()).toEqual(
      [plan.paths.credentialsFile, plan.paths.tokenFile, plan.paths.patchFile, plan.paths.pidFile].sort(),
    );
  });

  it("refuses a plan whose control URL or model is missing", () => {
    expect(() => launchPlan({ ...base, controlUrl: "", run: "30000000-0000-4000-8000-000000000005", dossier: "20000000-0000-4000-8000-000000000005", sessionId: "s" })).toThrow();
    expect(() => launchPlan({ ...base, model: "", run: "30000000-0000-4000-8000-000000000006", dossier: "20000000-0000-4000-8000-000000000006", sessionId: "s" })).toThrow();
  });

  it("提示词只留三条底线，操作步骤交给模型；网页搜索走控制面代理", async () => {
    const writes = new Map<string, string>();
    const plan = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000007", dossier: "20000000-0000-4000-8000-000000000007", sessionId: "ses_e" });
    await materializeLaunch(plan, "tok_live", {
      write: async (file: string, body: string) => void writes.set(file, body),
      remove: async () => {},
      mkdir: async () => {},
    });
    const patch = writes.get(plan.paths.patchFile) ?? "";
    for (const line of ["下载全文、写文件，要先得到用户批准", "不编造论文、作者和页码", "候选论文由用户来选"]) {
      expect(patch).toContain(line);
    }
    // 操作步骤类的规则不该再出现在提示词里。
    for (const banned of ["只搜", "不要重复同一查询", "读第 1-3 页", "至少写一条", "先写完 5 层"]) {
      expect(patch).not.toContain(banned);
    }
    expect(patch).toContain("searchProvider: deepseek-search-api");
    expect(patch).toContain("fetchProvider: deepseek-fetch-api");
    expect(patch).toContain(base.controlUrl + "/llm/deepseek/v1/tools");
  });

  it("容器模式：交给 dsh 的路径换成容器内，控制面读写仍是宿主路径", () => {
    const plan = launchPlan({
      ...base,
      run: "30000000-0000-4000-8000-000000000003",
      dossier: "20000000-0000-4000-8000-000000000003",
      sessionId: "ses_c",
      home: "/state/kernel",
      container: {
        home: "/opt/reinlab-account",
        dshHome: "/opt/reinlab-account/dsh-home",
        workspace: "/opt/reinlab-account/dossiers-root",
        dshModule: "/opt/reinlab/node_modules/@deepseek-ai/dsh/lib/bin.js",
        pluginEntry: "file:///opt/reinlab/plugins/reinlab-read-plugin/index.js",
        restrictPatch: "/opt/reinlab/plugins/reinlab-read-plugin/restrict.patch.yml",
      },
    });
    // 控制面照旧在宿主上读写这些文件。
    expect(plan.paths.runDir).toContain("/state/kernel/accounts/");
    expect(plan.paths.credentialsFile).toContain("/state/kernel/accounts/");
    // 交给 dsh 的是容器内路径。
    expect(plan.containerPaths?.credentialsFile).toContain("/opt/reinlab-account/");
    expect(plan.options.cwd).toBe("/opt/reinlab-account/dossiers-root/20000000-0000-4000-8000-000000000003");
    expect(plan.options.dshHome).toBe("/opt/reinlab-account/dsh-home");
    expect(plan.options.patches[0]).toBe("/opt/reinlab/plugins/reinlab-read-plugin/restrict.patch.yml");
    expect(plan.options.env.SHIM_DSH_MODULE).toBe("/opt/reinlab/node_modules/@deepseek-ai/dsh/lib/bin.js");
    // shim 要把参数里的宿主路径映射成容器内路径。
    expect(plan.options.env.SHIM_HOST_ROOT).toBe("/state/kernel/accounts/" + base.account);
    expect(plan.options.env.SHIM_CONTAINER_ROOT).toBe("/opt/reinlab-account");
  });

  it("宿主模式不产生容器路径，也不用容器内内核", () => {
    const plan = launchPlan({ ...base, run: "30000000-0000-4000-8000-000000000004", dossier: "20000000-0000-4000-8000-000000000004", sessionId: "ses_d", home: "/state/kernel" });
    expect(plan.containerPaths).toBeUndefined();
    expect(plan.options.env.SHIM_HOST_ROOT).toBeUndefined();
    expect(plan.options.cwd).toContain("/state/kernel/accounts/");
  });
});

describe("探索台运行补丁", () => {
  const explore = (run: string) =>
    launchPlan({
      ...base,
      run,
      dossier: "20000000-0000-4000-8000-000000000010",
      sessionId: "ses_explore",
      mode: "explore",
    });

  it("声明模型能收图，并让运行时自己重试格式错误（不伪造用户消息）", async () => {
    const writes = new Map<string, string>();
    const plan = explore("30000000-0000-4000-8000-000000000010");
    await materializeLaunch(plan, "tok", {
      write: async (file: string, body: string) => void writes.set(file, body),
      remove: async () => {},
      mkdir: async () => {},
    });
    const patch = writes.get(plan.paths.patchFile) ?? "";
    expect(patch).toContain("inputModalities: [text, image]");
    expect(patch).toContain("retryPolicy:");
    // 模型偶尔吐非法工具 JSON：交给运行时的重试策略，而不是我们注入一句「请重发」。
    expect(patch).toContain("MALFORMED_RESPONSE");
    expect(patch).toMatch(/maxRetries: \d+/);
    // 探索台的说话方式与底线
    expect(patch).toContain("旅拍规划搭档");
    expect(patch).not.toContain("研究精读助手");
  });

  it("精读模式不受影响：不加探索台那段配置", async () => {
    const writes = new Map<string, string>();
    const plan = launchPlan({
      ...base,
      run: "30000000-0000-4000-8000-000000000011",
      dossier: "20000000-0000-4000-8000-000000000011",
      sessionId: "ses_read",
      mode: "read",
    });
    await materializeLaunch(plan, "tok", {
      write: async (file: string, body: string) => void writes.set(file, body),
      remove: async () => {},
      mkdir: async () => {},
    });
    const patch = writes.get(plan.paths.patchFile) ?? "";
    expect(patch).not.toContain("inputModalities");
    expect(patch).not.toContain("retryPolicy");
  });
});
