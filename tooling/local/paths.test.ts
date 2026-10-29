import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localPaths } from "./paths";

/** 造一个只有状态的实例目录；真机上它就是 ~/.local/state/reinlab/<id>。 */
async function instance(root: string, id: string, files: string[] = ["runtime.env"]) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  for (const name of files) await writeFile(join(dir, name), "FIXTURE=1\n");
  return dir;
}

describe("local instance identity", () => {
  it("keeps every checkout of the same repository on one instance", async () => {
    // 集成本轮的要求：主目录成为日常入口后，本地实例标识不随 checkout 路径变化。
    const repo = await realpath(await mkdtemp(join(tmpdir(), "reinlab-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    const main = join(repo, "main");
    const worktree = join(repo, "worktree");
    await mkdir(main, { recursive: true });
    await mkdir(worktree, { recursive: true });

    // 两个 checkout 指向同一个 .git，因此共用一份状态目录。
    const first = localPaths({ root: main, stateRoot, env: {} });
    const second = localPaths({ root: worktree, stateRoot, env: {} });
    expect(second.state).toBe(first.state);
    expect(first.state.startsWith(stateRoot)).toBe(true);
  });

  it("reuses the instance an existing checkout already created instead of starting empty", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "reinlab-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    const legacyCheckout = join(repo, "old");
    await mkdir(legacyCheckout, { recursive: true });
    const legacy = localPaths({ root: legacyCheckout, stateRoot, env: {} });
    await instance(stateRoot, legacy.state.split("/").at(-1)!);
    await writeFile(join(legacy.state, "setup.env"), "APP_PASSWORD=fixture\n");

    // 换到同一仓库的另一个 checkout：仍是同一份状态，账号与业务数据不会被换成空实例。
    const other = localPaths({ root: join(repo, "new"), stateRoot, env: {} });
    expect(other.state).toBe(legacy.state);
    expect(other.setup).toBe(join(legacy.state, "setup.env"));
  });

  it("adopts the only instance already on this machine when no checkout matches yet", async () => {
    // 老工作树按路径哈希建的实例，迁入主目录后仍要被认出来。
    const repo = await realpath(await mkdtemp(join(tmpdir(), "reinlab-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    const existing = await instance(stateRoot, "0123456789ab", ["runtime.env", "setup.env"]);
    await mkdir(join(existing, "kernel"));

    // 状态根下还有这些非实例的固定目录，不能被当成实例。
    await mkdir(join(stateRoot, "account-credentials"));
    await mkdir(join(stateRoot, "papers"));

    const paths = localPaths({ root: join(repo, "main"), stateRoot, env: {} });
    expect(paths.state).toBe(existing);
  });

  it("starts a fresh instance when several instances exist and none belongs to this checkout", async () => {
    const repo = await realpath(await mkdtemp(join(tmpdir(), "reinlab-repo-")));
    execFileSync("git", ["init", "-q", repo]);
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    await instance(stateRoot, "0123456789ab");
    await instance(stateRoot, "abcdef012345");

    const paths = localPaths({ root: join(repo, "main"), stateRoot, env: {} });
    // 认不出归属时不能猜：给这个仓库一个稳定的新实例，两个都在的旧实例原样留着。
    expect(paths.state.startsWith(stateRoot)).toBe(true);
    expect(["0123456789ab", "abcdef012345"].includes(paths.state.split("/").at(-1)!)).toBe(false);
    expect(localPaths({ root: join(repo, "second"), stateRoot, env: {} }).state).toBe(paths.state);
  });

  it("lets the environment pick the state directory explicitly", async () => {
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    const explicit = join(stateRoot, "explicit");
    const paths = localPaths({ root: tmpdir(), stateRoot, env: { REINLAB_LOCAL_STATE_DIR: explicit } });
    expect(paths.state).toBe(explicit);
    expect(paths.runtime).toBe(join(explicit, "runtime.env"));
  });

  it("falls back to the checkout path outside a git repository", async () => {
    const plain = await realpath(await mkdtemp(join(tmpdir(), "reinlab-plain-")));
    const stateRoot = await realpath(await mkdtemp(join(tmpdir(), "reinlab-state-")));
    const paths = localPaths({ root: plain, stateRoot, env: { PATH: "/nonexistent" } });
    expect(paths.state.startsWith(stateRoot)).toBe(true);
    expect(localPaths({ root: plain, stateRoot, env: { PATH: "/nonexistent" } }).state).toBe(paths.state);
  });
});
