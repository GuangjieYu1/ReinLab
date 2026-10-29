import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { ApiFailure } from "../api/errors";
import type { CardDeposit } from "../mcp/handler";
import type { PaperDeposit } from "../mcp/papers";

const unsafe = () =>
  new ApiFailure("ACCOUNT_PATH_UNSAFE", 503, "账户文件目录不可用。");

async function ensureRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root)) throw unsafe();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077))
    throw unsafe();
  if ((await realpath(root)) !== root) throw unsafe();
  return root;
}

async function writeAtomic(directory: string, name: string, body: Buffer) {
  const target = path.join(directory, name);
  const temporary = path.join(directory, "." + name + ".pending");
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rm(target, { force: true });
  await (await import("node:fs/promises")).rename(temporary, target);
}

/**
 * Local account file port for the host kernel transport.
 *
 * It keeps the account-scoped directory layout the container used
 * (`<root>/dossiers/<dossier>/papers|cards/...`) so the same read-back code
 * finds the artifacts, without requiring the account image.
 */
export function localAccountPort(root: string) {
  const dossierRoot = (dossier: string) => path.join(root, "dossiers", dossier);

  const deposit: PaperDeposit = async (context, assetId, bytes, metadata) => {
    const base = await ensureRoot(root);
    const directory = path.join(dossierRoot(context.claims.dossier), "papers");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory) throw unsafe();
    await writeAtomic(directory, assetId + ".json", Buffer.from(JSON.stringify(metadata)));
    if (bytes) await writeAtomic(directory, assetId + ".pdf", bytes);
    if (!(await lstat(base)).isDirectory()) throw unsafe();
  };

  const cardDeposit: CardDeposit = async (context, id, name, card, writeTargets) => {
    await ensureRoot(root);
    const directory = path.join(dossierRoot(context.claims.dossier), "cards");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!writeTargets.length) throw unsafe();
    await writeAtomic(directory, id + ".json", Buffer.from(JSON.stringify({ name, card })));
  };

  const cleanup = async (account: string, run: string) => {
    // Run-scoped capability tokens live in memory only; nothing to remove.
    void account;
    void run;
  };

  return { deposit, cardDeposit, cleanup };
}
