import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** dsh refuses to boot inside Electron; the local stack must never run there. */
export const ELECTRON_RUNTIME_FORBIDDEN =
  "LOCAL_ELECTRON_RUNTIME_FORBIDDEN: 这个命令行运行在 Electron 运行时里（dsh 内核不认这个运行时）。请改用：pnpm local:up22（或 bash tooling/local/start.sh）起栈。";
export const NODE22_REQUIRED =
  "LOCAL_NODE22_REQUIRED: 需要项目工具链的 Node 22；没有找到 ~/.local/share/reinlab/toolchains/node-v22*/bin/node。";

/**
 * Electron is recognised by its reported version, by a non-node release name,
 * or by an executable that is the desktop app binary itself (not a `node`).
 */
export function isElectronRuntime(
  versions: Record<string, string | undefined> = process.versions as Record<string, string | undefined>,
  execPath: string = process.execPath,
  release: { name?: string } = process.release,
) {
  if (versions.electron) return true;
  if (release?.name && release.name !== "node") return true;
  return /Contents\/MacOS\/[^/]+$/.test(execPath) && !/\/node$/.test(execPath);
}

/** The pinned Node 22 toolchain, never PATH's `node`. */
export async function resolveNode22(): Promise<string> {
  if (process.env.REINLAB_NODE_BIN) {
    if (!existsSync(process.env.REINLAB_NODE_BIN)) throw Error(NODE22_REQUIRED);
    return process.env.REINLAB_NODE_BIN;
  }
  const root = join(homedir(), ".local/share/reinlab/toolchains");
  const entries = await readdir(root).catch(() => [] as string[]);
  const candidates = entries
    .filter((name) => /^node-v22\.\d+\.\d+-/.test(name))
    .sort((a, b) =>
      b.localeCompare(a, "en", { numeric: true }),
    )
    .map((name) => join(root, name, "bin/node"))
    .filter((file) => existsSync(file));
  if (!candidates.length) throw Error(NODE22_REQUIRED);
  return candidates[0];
}

/**
 * Run the local stack on the project's Node 22.
 *
 * Electron is refused outright (dsh will not start there). Any other runtime is
 * replaced by the pinned toolchain binary, so PATH's `node` never matters.
 */
export async function ensureNode22(script: string): Promise<string> {
  if (isElectronRuntime()) throw Error(ELECTRON_RUNTIME_FORBIDDEN);
  const toolchain = await resolveNode22();
  if (process.execPath === toolchain) return toolchain;
  const child = spawn(toolchain, ["--import", "tsx", script, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, REINLAB_NODE22_REEXEC: "1" },
  });
  const code = await new Promise<number>((resolve) => {
    child.on("exit", (value) => resolve(value ?? 1));
    child.on("error", () => resolve(1));
  });
  process.exit(code);
  return toolchain;
}
