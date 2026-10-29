import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accountContainerSpec, assertSpecSafe, containerNameFor, type AccountContainerInput } from "./container";

const run = promisify(execFile);

/** 只把用到的 docker 动作抽出来，方便测试与替换。 */
export type DockerRunner = {
  /** 容器是否正在运行。 */
  isRunning(name: string): Promise<boolean>;
  /** 用给定参数建并启动容器。 */
  start(args: string[], env: Record<string, string>): Promise<void>;
  remove(name: string): Promise<void>;
};

export const dockerRunner: DockerRunner = {
  async isRunning(name) {
    try {
      const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", name], {
        timeout: 10_000,
      });
      return stdout.trim() === "true";
    } catch {
      return false;
    }
  },
  async start(args, env) {
    await run("docker", args, {
      timeout: 120_000,
      env: { ...process.env, ...env },
    });
  },
  async remove(name) {
    await run("docker", ["rm", "-f", name], { timeout: 30_000 }).catch(() => undefined);
  },
};

/**
 * 确保这个账户的执行容器在跑。
 *
 * 每账户一个容器，已存在就复用（不重建，避免把容器里的工作草稿弄没），
 * 不存在才按规格创建。规格先过 `assertSpecSafe`，边界不合格直接拒绝启动，
 * 不会「先跑起来再说」。
 */
export async function ensureAccountContainer(
  input: AccountContainerInput,
  options: { docker?: DockerRunner } = {},
): Promise<{ name: string; created: boolean }> {
  const docker = options.docker ?? dockerRunner;
  const name = containerNameFor(input.account);
  if (await docker.isRunning(name)) return { name, created: false };
  // 容器存在但没在跑：先清掉，再用同一份规格重建，避免带着旧挂载复活。
  await docker.remove(name);
  const spec = accountContainerSpec(input);
  assertSpecSafe(spec);
  await docker.start(spec.createArgs, spec.env);
  return { name, created: true };
}

/** 账户回收时清掉它的容器。只作用于这一个账户。 */
export async function removeAccountContainer(
  account: string,
  options: { docker?: DockerRunner } = {},
): Promise<void> {
  const docker = options.docker ?? dockerRunner;
  await docker.remove(containerNameFor(account));
}
