/** Runs inside a read-only named volume helper; returns hashes only, never file bytes. */
export async function privateHatchetDigest(root, expectedUid = 0) {
  const { open, lstat, readdir } = await import("node:fs/promises");
  const { constants } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const deny = () => {
    throw Error("HATCHET_CONFIGURATION_DRIFT");
  };
  const directory = await lstat(root);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    directory.uid !== expectedUid ||
    (directory.mode & 0o777) !== 0o700
  )
    deny();
  const names = ["database.yaml", "pgpass", "server.yaml"];
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify(names))
    deny();
  const hashes = {};
  for (const name of names) {
    const handle = await open(
      root + "/" + name,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== expectedUid ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 2097152
      )
        deny();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs ||
        bytes.length !== stat.size
      )
        deny();
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
    } finally {
      await handle.close();
    }
  }
  return ["database.yaml", "server.yaml", "pgpass"]
    .map((name) => hashes[name])
    .join(":");
}
