import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";

/**
 * The instance id keys the local state directory (`~/.local/state/reinlab/<id>`):
 * the runtime config, the control/frontend records, and the kernel home holding
 * dossiers, papers and per-account DSH sessions.
 *
 * It used to hash the checkout path, so running the same stack from another
 * worktree silently produced a second, empty instance. Identity now comes from
 * the repository, which keeps the existing accounts, provider configuration and
 * business data when day-to-day work moves to another checkout.
 */
const INSTANCE_ID = /^[0-9a-f]{12}$/;
/** Fixed directories under the state root that are not instances. */
const NOT_AN_INSTANCE = new Set(["account-credentials", "papers"]);

/**
 * The git directory shared by every worktree of this repository.
 * Outside a git repository the caller falls back to the checkout path.
 */
export function repositoryIdentity(root: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return dotGit;
      // A linked worktree: ".git" is a file pointing at the shared git directory.
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!pointer) return undefined;
      const worktreeGitDir = resolve(dir, pointer[1].trim());
      return resolve(worktreeGitDir, readFileSync(join(worktreeGitDir, "commondir"), "utf8").trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function instanceDirectories(stateRoot: string): string[] {
  try {
    return readdirSync(stateRoot)
      .filter((name) => INSTANCE_ID.test(name) && !NOT_AN_INSTANCE.has(name))
      .filter((name) => {
        try {
          return statSync(join(stateRoot, name)).isDirectory();
        } catch {
          return false;
        }
      })
      // 只认已经起过栈的实例：有运行时配置或内核目录才算，空目录不当作可沿用。
      .filter((name) => ["runtime.env", "setup.env", "kernel"].some((marker) => {
        try {
          statSync(join(stateRoot, name, marker));
          return true;
        } catch {
          return false;
        }
      }))
      .sort();
  } catch {
    return [];
  }
}

export function localPaths(
  options: { root?: string; stateRoot?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const root = resolve(options.root ?? ".");
  const stateRoot = options.stateRoot ?? join(homedir(), ".local/state/reinlab");
  const env = options.env ?? process.env;
  const id = createHash("sha256")
    .update(repositoryIdentity(root) ?? root)
    .digest("hex")
    .slice(0, 12);
  let state = join(stateRoot, id);
  if (!env.REINLAB_LOCAL_STATE_DIR) {
    // 本机只有一个实例、而这个仓库还没建过时沿用它：从旧工作树迁到主目录
    // 不能静默变成空实例。可见多个实例说明归属不唯一，此时不猜，按仓库新建。
    const existing = instanceDirectories(stateRoot);
    if (!existing.includes(id) && existing.length === 1) state = join(stateRoot, existing[0]);
  }
  state = env.REINLAB_LOCAL_STATE_DIR ?? state;
  return {
    root,
    state,
    runtime: join(state, "runtime.env"),
    setup: join(state, "setup.env"),
    process: join(state, "control.json"),
  };
}
