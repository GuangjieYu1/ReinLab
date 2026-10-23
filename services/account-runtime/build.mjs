import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../../dist/account-runtime"),
  source = path.join(out, "upstream");
const pin = JSON.parse(
  await readFile(path.join(here, "build-inputs/source.json"), "utf8"),
);
const bun = process.env.REINLAB_BUN_BINARY || "bun";
const run = (bin, args, cwd = out) => {
  const result = spawnSync(bin, args, {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: "1" },
    stdio: "inherit",
  });
  if (result.status !== 0) throw Error("ACCOUNT_BUILD_FAILED");
};
await mkdir(out, { recursive: true });
const version = spawnSync(bun, ["--version"], { encoding: "utf8" });
if (version.stdout?.trim() !== pin.bun)
  throw Error("ACCOUNT_BUILD_BUN_VERSION");
const archive = path.join(out, "upstream.tar.gz");
try {
  await access(archive);
} catch {
  run("curl", [
    "--fail",
    "--location",
    "--proto",
    "=https",
    "--tlsv1.2",
    "https://codeload.github.com/synthetic-sciences/openscience/tar.gz/" +
      pin.commit,
    "-o",
    archive,
  ]);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha(await readFile(archive)) !== pin.archiveSha256)
  throw Error("ACCOUNT_BUILD_SOURCE_HASH");
await mkdir(source, { recursive: true });
run("tar", ["-xzf", archive, "--strip-components=1", "-C", source]);
const snapshot = gunzipSync(
  await readFile(path.join(here, "build-inputs/models-snapshot.ts.gz")),
);
if (sha(snapshot) !== pin.snapshotSha256)
  throw Error("ACCOUNT_BUILD_SNAPSHOT_HASH");
await writeFile(
  path.join(source, "backend/cli/src/provider/models-snapshot.ts"),
  snapshot,
);
run(
  bun,
  [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--filter",
    "@synsci/openscience",
    "--filter",
    "@synsci/sdk",
    "--filter",
    "@synsci/plugin",
  ],
  source,
);
// Only a disposable archive is generated/built. Never writes to the user's upstream checkout.
for (const file of ["credentials.mjs", "network-guard.mjs"])
  await copyFile(path.join(here, file), path.join(out, file));
await copyFile(
  path.join(here, "deployment-entry.ts"),
  path.join(out, "entry.ts"),
);
await copyFile(path.join(here, "compile.ts"), path.join(out, "compile.ts"));
run(bun, ["run", "compile.ts"]);
for (const file of ["LICENSE", "NOTICE", "bun.lock"])
  await copyFile(path.join(source, file), path.join(out, file));
const binary = path.join(out, "reinlab-openscience");
await writeFile(
  path.join(out, "manifest.json"),
  JSON.stringify(
    {
      ...pin,
      artifact: "original source + ReinLab network authentication adapter",
      binarySha256: sha(await readFile(binary)),
    },
    null,
    2,
  ) + "\n",
);
console.log(JSON.stringify({ code: "ACCOUNT_BUILD_OK", version: pin.version }));
