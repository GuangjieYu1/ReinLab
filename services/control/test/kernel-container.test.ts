import { describe, expect, it } from "vitest";
import {
  accountContainerSpec,
  assertSpecSafe,
  containerNameFor,
  isForbiddenEnv,
} from "../src/kernel/container";

const base = {
  account: "0e1ebf8a-8397-4c6a-b21c-dc6692867248",
  image: "reinlab-account:dev",
  accountRoot: "/Users/someone/.local/state/reinlab/803a04fcd69a/kernel/accounts/acc",
  controlUrl: "http://host.docker.internal:3001",
  tokenFile: "/Users/someone/.local/state/reinlab/803a04fcd69a/kernel/accounts/acc/token",
};

describe("每账户执行容器规格", () => {
  it("只挂当前账户的根与令牌，工作区可写、令牌只读", () => {
    const spec = accountContainerSpec(base);
    const rw = spec.mounts.filter((m) => m.mode === "rw");
    const ro = spec.mounts.filter((m) => m.mode === "ro");
    expect(rw).toHaveLength(1);
    expect(rw[0].host).toBe(base.accountRoot);
    expect(ro.some((m) => m.host === base.tokenFile)).toBe(true);
    // 容器名按账户固定，同一账户复用。
    expect(spec.name).toBe(containerNameFor(base.account));
    expect(containerNameFor("AAAA-bbbb")).toBe(containerNameFor("aaaabbbb"));
  });

  it("Provider key 与基础设施凭据不进容器环境", () => {
    const spec = accountContainerSpec(base, {
      DEEPSEEK_API_KEY: "sk-should-not-pass",
      SUPABASE_SERVICE_ROLE_KEY: "should-not-pass",
      DATABASE_URL: "postgres://x",
      DOCKER_HOST: "unix:///var/run/docker.sock",
      GITHUB_TOKEN: "ghp_x",
      RUN_TOKEN: "also-not",
      // 运行本身需要的一个正当变量
      SHIM_NODE: "/usr/local/bin/node",
    });
    const names = Object.keys(spec.env);
    for (const forbidden of [
      "DEEPSEEK_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DATABASE_URL",
      "DOCKER_HOST",
      "GITHUB_TOKEN",
      "RUN_TOKEN",
    ])
      expect(names).not.toContain(forbidden);
    expect(spec.env.SHIM_NODE).toBe("/usr/local/bin/node");
    expect(() => assertSpecSafe(spec)).not.toThrow();
  });

  it("宿主专用路径不出现在容器参数里", () => {
    const spec = accountContainerSpec(base);
    const blob = JSON.stringify(spec.createArgs);
    expect(blob).not.toContain("/.ssh/");
    expect(blob).not.toContain("/.config/reinlab/");
    expect(blob).not.toContain("docker.sock");
    expect(blob).not.toContain("/.codex/");
    expect(() => assertSpecSafe(spec)).not.toThrow();
  });

  it("容器以只读根、去掉能力、禁止提权启动", () => {
    const spec = accountContainerSpec(base);
    expect(spec.createArgs).toContain("--read-only");
    expect(spec.createArgs).toContain("--cap-drop");
    expect(spec.createArgs).toContain("ALL");
    expect(spec.createArgs.join(" ")).toContain("no-new-privileges");
  });

  it("自检能挡住漏进来的宿主路径与凭据", () => {
    const spec = accountContainerSpec(base);
    expect(() =>
      assertSpecSafe({ ...spec, createArgs: [...spec.createArgs, "-v", "/home/u/.ssh:/x:ro"] }),
    ).toThrow(/LEAKS_HOST_PATH/);
    expect(() =>
      assertSpecSafe({ ...spec, env: { ...spec.env, DEEPSEEK_API_KEY: "x" } }),
    ).toThrow(/LEAKS_SECRET/);
    expect(() =>
      assertSpecSafe({
        ...spec,
        mounts: [
          ...spec.mounts,
          { host: "/var/run/docker.sock", container: "/s", mode: "ro" as const },
        ],
      }),
    ).toThrow(/DOCKER_SOCKET/);
  });

  it("凭据判据覆盖常见命名", () => {
    for (const name of ["DEEPSEEK_API_KEY", "OPENAI_KEY", "AWS_SECRET", "SUPABASE_ANON_KEY", "GITHUB_TOKEN", "RUN_TOKEN"])
      expect(isForbiddenEnv(name)).toBe(true);
    for (const name of ["SHIM_NODE", "REINLAB_CONTROL_URL", "REINLAB_ACCOUNT_ROOT"])
      expect(isForbiddenEnv(name)).toBe(false);
  });
});
