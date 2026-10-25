import { getuid } from 'node:process';
import { constants } from "node:fs";
import { lstat, realpath, mkdir, open, link, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
/** Operator evidence: canonical owner-only directory, atomic no-replace 0600 files. */
export async function privateEvidenceDirectory(raw: string) {
  const directory = resolve(raw);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw Error("PRIVATE_EVIDENCE_UNSAFE");
  return directory;
}
export async function writePrivateEvidence(
  file: string,
  bytes: string | Uint8Array
) {
  await privateEvidenceDirectory(dirname(file));
  try {
    await lstat(file);
    throw Error("PRIVATE_EVIDENCE_EXISTS");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600
    )
      throw Error("PRIVATE_EVIDENCE_UNSAFE");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, file);
    await unlink(temporary);
    const directory = await open(
      dirname(file),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => {});
  }
}
