import { randomUUID, createHash } from "node:crypto";
import { link, unlink, readFile } from "node:fs/promises";
import { readPrivateEnv, writePrivateEnv } from "./config";

export const ACCOUNT_IMAGE_INPUTS = [
  "infra/fly/account.Dockerfile",
  "services/account-runtime/build.mjs",
  "services/account-runtime/compile.ts",
  "services/account-runtime/deployment-entry.ts",
  "services/account-runtime/credentials.mjs",
  "services/account-runtime/network-guard.mjs",
  "services/account-runtime/build-inputs/source.json",
  "services/account-runtime/build-inputs/models-snapshot.ts.gz",
  "infra/fly/account-entrypoint.mjs",
  "infra/fly/account-health.mjs",
  "plugins/reinlab-os-plugin/index.js",
  "plugins/reinlab-os-plugin/mcp-tools.js",
  "services/account-runtime/mcp/files.py",
  "services/account-runtime/mcp/client.mjs",
  "services/account-runtime/mcp/store.mjs",
  "services/control/src/bridge/openscience/role-project.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/contracts/package.json",
  "services/control/package.json",
  "services/worker/package.json",
  "services/account-runtime/package.json",
  "plugins/reinlab-os-plugin/package.json",
] as const;
export async function accountImageTag(
  read: (path: string) => Promise<Buffer> = (path) => readFile(path),
) {
  const hash = createHash("sha256");
  for (const file of ACCOUNT_IMAGE_INPUTS) {
    const bytes = await read(file);
    hash.update(JSON.stringify([file, bytes.length]) + "\n");
    hash.update(bytes);
  }
  return "reinlab-account:local-" + hash.digest("hex").slice(0, 12);
}

const digest = /^sha256:[a-f0-9]{64}$/;
const imageName = /^reinlab-account:local-[a-f0-9]{12}$/;
const failure = (code: string) => new Error(code);
export type ImageObservation = {
  image: string;
  currentId: string | null;
  pinnedId: string | null;
  containers: { reference: string; imageId: string }[];
};
/** No resource operations: a mutable tag never substitutes a saved immutable image identity. */
export function decideLocalImage(
  input: ImageObservation,
): "reuse" | "pin" | "build" {
  if (
    !imageName.test(input.image) ||
    [input.currentId, input.pinnedId].some(
      (v) => v !== null && !digest.test(v),
    ) ||
    input.containers.some(
      (c) => typeof c.reference !== "string" || !digest.test(c.imageId),
    )
  )
    throw failure("LOCAL_IMAGE_METADATA_INVALID");
  if (input.pinnedId) {
    if (input.currentId === null) throw failure("LOCAL_IMAGE_PIN_MISSING");
    if (input.currentId !== input.pinnedId)
      throw failure("LOCAL_IMAGE_PIN_CHANGED");
  }
  if (
    input.containers.some(
      (c) => c.reference === input.image && c.imageId !== input.currentId,
    )
  )
    throw failure("LOCAL_IMAGE_REFERENCE_CONFLICT");
  if (input.pinnedId) return "reuse";
  return input.currentId ? "pin" : "build";
}
export type LocalImageRunner = (
  args: string[],
  timeoutMs: number,
) => Promise<string>;
async function safeRun(
  run: LocalImageRunner,
  args: string[],
  timeoutMs = 15000,
) {
  try {
    return await run(args, timeoutMs);
  } catch {
    throw failure(
      args[0] === "build"
        ? "LOCAL_IMAGE_BUILD_FAILED"
        : "LOCAL_IMAGE_READ_FAILED",
    );
  }
}
async function currentImageId(image: string, run: LocalImageRunner) {
  const listed = (
    await safeRun(run, [
      "image",
      "ls",
      "--no-trunc",
      "--quiet",
      "--filter",
      "reference=" + image,
    ])
  ).trim();
  if (!listed) return null;
  if (!digest.test(listed)) throw failure("LOCAL_IMAGE_METADATA_INVALID");
  const inspected = (
    await safeRun(run, ["image", "inspect", "--format", "{{.Id}}", image])
  ).trim();
  if (!digest.test(inspected)) throw failure("LOCAL_IMAGE_METADATA_INVALID");
  if (inspected !== listed) throw failure("LOCAL_IMAGE_PIN_CHANGED");
  return inspected;
}
async function containerReferences(run: LocalImageRunner) {
  const raw = (
    await safeRun(run, [
      "container",
      "ls",
      "--all",
      "--no-trunc",
      "--format",
      "{{.ID}}",
    ])
  ).trim();
  const ids = raw ? raw.split("\n") : [];
  if (ids.length > 1000 || ids.some((id) => !/^[a-f0-9]{64}$/.test(id)))
    throw failure("LOCAL_IMAGE_METADATA_INVALID");
  const references: { reference: string; imageId: string }[] = [];
  if (ids.length === 0) return references;
  // Templates deliberately expose only identity fields, never Config.Env or full inspect JSON.
  const output = (
    await safeRun(run, [
      "container",
      "inspect",
      "--format",
      '[{{if index .Config.Labels "io.reinlab.image"}}{{json (index .Config.Labels "io.reinlab.image")}}{{else}}{{json .Config.Image}}{{end}},{{json .Image}}]',
      ...ids,
    ])
  ).trim();
  const results = output ? output.split("\n") : [];
  if (results.length !== ids.length)
    throw failure("LOCAL_IMAGE_METADATA_INVALID");
  for (const result of results) {
    let value: unknown;
    try {
      value = JSON.parse(result);
    } catch {
      throw failure("LOCAL_IMAGE_METADATA_INVALID");
    }
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string" ||
      !digest.test(value[1])
    )
      throw failure("LOCAL_IMAGE_METADATA_INVALID");
    references.push({ reference: value[0], imageId: value[1] });
  }
  return references;
}
async function readPin(file: string, image: string) {
  try {
    const pin = await readPrivateEnv(file);
    if (
      Object.keys(pin).sort().join(",") !== "IMAGE_ID,IMAGE_REFERENCE" ||
      pin.IMAGE_REFERENCE !== image ||
      !digest.test(pin.IMAGE_ID)
    )
      throw failure("LOCAL_IMAGE_PIN_INVALID");
    return pin.IMAGE_ID;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure("LOCAL_IMAGE_PIN_INVALID");
  }
}
async function publishPin(file: string, image: string, imageId: string) {
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writePrivateEnv(temporary, {
      IMAGE_REFERENCE: image,
      IMAGE_ID: imageId,
    });
    // Atomic no-replace publication: crashes cannot leave a partial pin, and an old pin is never overwritten.
    await link(temporary, file);
  } catch {
    throw failure("LOCAL_IMAGE_PIN_WRITE_FAILED");
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
/** Caller holds the local:up lock. No implicit repair, prune, retag or account resource mutation. */
export async function ensureLocalAccountImage(input: {
  image: string;
  pinFile: string;
  run: LocalImageRunner;
}) {
  if (!imageName.test(input.image))
    throw failure("LOCAL_IMAGE_METADATA_INVALID");
  const pinnedId = await readPin(input.pinFile, input.image),
    currentId = await currentImageId(input.image, input.run),
    containers = await containerReferences(input.run);
  const decision = decideLocalImage({
    image: input.image,
    pinnedId,
    currentId,
    containers,
  });
  if (decision === "build")
    await safeRun(
      input.run,
      ["build", "-f", "infra/fly/account.Dockerfile", "-t", input.image, "."],
      900000,
    );
  const finalId = await currentImageId(input.image, input.run);
  if (finalId === null) throw failure("LOCAL_IMAGE_PIN_MISSING");
  if (decision !== "build" && finalId !== currentId)
    throw failure("LOCAL_IMAGE_PIN_CHANGED");
  decideLocalImage({
    image: input.image,
    pinnedId,
    currentId: finalId,
    containers: await containerReferences(input.run),
  });
  if (pinnedId === null) await publishPin(input.pinFile, input.image, finalId);
  return finalId;
}
