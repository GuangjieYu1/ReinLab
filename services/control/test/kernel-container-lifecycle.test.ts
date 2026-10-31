import { describe, expect, it, vi } from "vitest";
import { ensureAccountContainer, removeAccountContainer, type DockerRunner } from "../src/kernel/container-lifecycle";
import { containerNameFor } from "../src/kernel/container";

const input = {
  account: "0e1ebf8a-8397-4c6a-b21c-dc6692867248",
  image: "reinlab-account:dev",
  accountRoot: "/tmp/reinlab-state/kernel/accounts/acc",
  controlUrl: "http://host.docker.internal:3001",
  tokenFile: "/tmp/reinlab-state/kernel/accounts/acc/token",
};

function fakeDocker(over: Partial<DockerRunner> = {}): DockerRunner & { starts: string[][]; removes: string[] } {
  const starts: string[][] = [];
  const removes: string[] = [];
  return {
    starts,
    removes,
    isRunning: async () => false,
    start: async (args) => {
      starts.push(args);
    },
    remove: async (name) => {
      removes.push(name);
    },
    ...over,
  };
}

describe("账户容器生命周期", () => {
  it("账户容器已在跑就复用，不重建（容器里的草稿要留住）", async () => {
    const docker = fakeDocker({ isRunning: async () => true });
    const result = await ensureAccountContainer(input, { docker });
    expect(result.created).toBe(false);
    expect(docker.starts).toHaveLength(0);
    expect(docker.removes).toHaveLength(0);
  });

  it("没有容器时按规格创建，且规格先过安全自检", async () => {
    const docker = fakeDocker();
    const result = await ensureAccountContainer(input, { docker });
    expect(result.created).toBe(true);
    expect(result.name).toBe(containerNameFor(input.account));
    expect(docker.starts).toHaveLength(1);
    const args = docker.starts[0].join(" ");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    // 只挂账户根与令牌，没有宿主 home/仓库/socket。
    expect(args).not.toContain("/.ssh");
    expect(args).not.toContain("docker.sock");
  });

  it("容器存在但没在跑：先清掉再按同一份规格重建，避免带旧挂载复活", async () => {
    const docker = fakeDocker();
    const result = await ensureAccountContainer(input, { docker });
    expect(result.created).toBe(true);
    expect(docker.removes).toEqual([containerNameFor(input.account)]);
    expect(docker.starts).toHaveLength(1);
  });

  it("回收只作用于这一个账户的容器", async () => {
    const docker = fakeDocker();
    await removeAccountContainer(input.account, { docker });
    expect(docker.removes).toEqual([containerNameFor(input.account)]);
  });

  it("凭据误传时拒绝启动，不会先跑起来再说", async () => {
    const docker = fakeDocker();
    // 让规格带上一个不该出现的宿主路径，assertSpecSafe 必须拦住。
    await expect(
      // 令牌不再按文件挂载，改成让账户根落在宿主凭据目录来触发自检。
      ensureAccountContainer({ ...input, accountRoot: "/home/u/.ssh" }, { docker }),
    ).rejects.toThrow(/LEAKS_HOST_PATH/);
    expect(docker.starts).toHaveLength(0);
  });

  it("镜像更新了、账户没任务在跑：重建容器（老账户不能一直用旧插件）", async () => {
    const docker = fakeDocker({
      isRunning: async () => true,
      containerImageId: async () => "sha256:old",
      imageId: async () => "sha256:new",
    });
    const result = await ensureAccountContainer(input, { docker, busy: false });
    expect(result.created).toBe(true);
    expect(docker.removes).toHaveLength(1);
    expect(docker.starts).toHaveLength(1);
  });

  it("镜像更新了但有任务在跑：先沿用旧容器，不打断", async () => {
    const docker = fakeDocker({
      isRunning: async () => true,
      containerImageId: async () => "sha256:old",
      imageId: async () => "sha256:new",
    });
    const result = await ensureAccountContainer(input, { docker, busy: true });
    expect(result.created).toBe(false);
    expect(docker.starts).toHaveLength(0);
  });

  it("镜像没变：照常复用，不为重建而重建", async () => {
    const docker = fakeDocker({
      isRunning: async () => true,
      containerImageId: async () => "sha256:same",
      imageId: async () => "sha256:same",
    });
    const result = await ensureAccountContainer(input, { docker });
    expect(result.created).toBe(false);
    expect(docker.starts).toHaveLength(0);
  });
});
