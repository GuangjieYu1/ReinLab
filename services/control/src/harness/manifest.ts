import { BenchManifest, ToolRegistry, CapabilityRegistryDocument, legacyRegistryCore } from "@reinlab/contracts";
import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseDocument, visit, isAlias, isNode } from "yaml";
import { canonical } from "../api/context";
export type LoadedBenchBundle = {
  manifest: BenchManifest;
  digest: string;
  prompts: Record<string, string>;
  referencedHashes: Record<string, string>;
  registryHash: string;
  schemas?: Record<string,string>;
};
export class BenchManifestError extends Error {
  readonly code = "BENCH_MANIFEST_INVALID";
  readonly status = 503;
  constructor(
    readonly issues: Array<{ path: Array<string | number>; message: string }>,
  ) {
    super("工作台清单或引用未通过验证。");
  }
}
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
function failure(field: Array<string | number>, message: string): never {
  throw new BenchManifestError([{ path: field, message }]);
}
function relative(value: string) {
  return (
    value.length > 0 &&
    value.length <= 300 &&
    value === value.trim() &&
    !/[\\:\u0000-\u001f]/.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (part, i, all) =>
          part !== "." &&
          part !== ".." &&
          (part !== "" || i === all.length - 1),
      )
  );
}
function checkedTree(
  value: unknown,
  field: Array<string | number> = [],
  depth = 0,
  state = { nodes: 0 },
) {
  if (depth > 24 || ++state.nodes > 20000)
    failure(field.length ? field : ["manifest"], "配置超过结构上限");
  if (typeof value === "string") {
    if (/\{(?:file|env):/i.test(value))
      failure(field.length ? field : ["manifest"], "禁止配置引用插值");
    return;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return;
  if (!value || typeof value !== "object")
    failure(field.length ? field : ["manifest"], "配置必须是JSON数据");
  for (const [key, item] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key))
      failure([...field, key], "禁止原型字段");
    if (/\{(?:file|env):/i.test(key))
      failure([...field, "key"], "禁止配置引用插值");
    checkedTree(
      item,
      [...field, Array.isArray(value) ? Number(key) : key],
      depth + 1,
      state,
    );
  }
}
function parseDocumentStrict(text: string, field: string): unknown {
  try {
    if (/\{(?:file|env):/i.test(text)) failure([field], "禁止配置引用插值");
    const document = parseDocument(text, {
      version: "1.2",
      schema: "core",
      strict: true,
      uniqueKeys: true,
      merge: false,
      customTags: [],
    });
    if (document.errors.length || document.warnings.length)
      failure([field], "YAML语法或标记无效");
    let nodes = 0;
    visit(document, (_key, node, ancestors) => {
      if (++nodes > 20000 || ancestors.length > 48)
        failure([field], "配置超过结构上限");
      if (isAlias(node) || (isNode(node) && (node.anchor || node.tag)))
        failure([field], "禁止YAML别名、锚点或显式标记");
    });
    const value = document.toJS({ maxAliasCount: 0 });
    checkedTree(value);
    return value;
  } catch (error) {
    if (error instanceof BenchManifestError) throw error;
    return failure([field], "清单无法安全解析");
  }
}
async function ancestors(root: string, relativeFile: string) {
  let directory = root;
  for (const segment of relativeFile.split("/").slice(0, -1)) {
    directory = path.join(directory, segment);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      failure([relativeFile], "引用目录必须是普通目录");
  }
}
async function bytes(
  root: string,
  relativeFile: string,
  maximum: number,
): Promise<Buffer> {
  if (!relative(relativeFile) || relativeFile.endsWith("/"))
    failure([relativeFile], "引用必须是bundle内相对普通文件");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await ancestors(root, relativeFile);
    const file = path.join(root, relativeFile);
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum)
      failure([relativeFile], "引用不是有界单link普通文件");
    const data = await handle.readFile();
    if (data.length > maximum) failure([relativeFile], "引用超过大小限制");
    const current = await lstat(file);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      (await realpath(file)) !== file
    )
      failure([relativeFile], "引用在读取时改变");
    await ancestors(root, relativeFile);
    return data;
  } catch (error) {
    if (error instanceof BenchManifestError) throw error;
    return failure([relativeFile], "引用缺失或路径不安全");
  } finally {
    await handle?.close();
  }
}
async function rootPath(root: string) {
  const absolute = path.resolve(root);
  if ((await realpath(absolute)) !== absolute)
    failure(["root"], "bundle根目录必须是canonical路径");
  return absolute;
}
function decode(data: Buffer, field: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return failure([field], "引用必须是UTF-8文本");
  }
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
export async function loadRegistryDocument(
  root = repositoryRoot,
): Promise<CapabilityRegistryDocument> {
  const base = await rootPath(root),
    raw = parseDocumentStrict(
      decode(await bytes(base, "tools/registry.json", 262144), "registry"),
      "registry",
    );
  const parsed = CapabilityRegistryDocument.safeParse(raw);
  if (!parsed.success)
    throw new BenchManifestError(
      parsed.error.issues.map((issue) => ({
        path: ["registry", ...issue.path],
        message: "工具注册表字段无效",
      })),
    );
  return frozen(parsed.data);
}
export async function loadToolRegistry(root = repositoryRoot): Promise<ToolRegistry> {
  return frozen(legacyRegistryCore(await loadRegistryDocument(root)));
}
/** Universal non-overridable policy; reuse after merging trusted patches. */
export function assertBenchSafety(
  manifest: BenchManifest,
  registry: ToolRegistry,
) {
  checkedTree(manifest);
  checkedTree(registry);
  for (const [role, definition] of Object.entries(manifest.roles)) {
    for (const [tool, permission] of Object.entries(definition.tools)) {
      const field = ["roles", role, "tools", tool];
      if (tool === "*" || tool === "task") {
        if (permission !== "deny") failure(field, "默认通配符和task只能禁止");
        if (tool === "*") continue;
      }
      if (!Object.hasOwn(registry.tools, tool))
        failure(field, "工具没有已声明契约");
      if (registry.tools[tool].risk === "danger" && permission === "allow")
        failure(field, "danger工具不能直接允许");
    }
    for (const [index, target] of definition.write_targets.entries())
      if (!relative(target))
        failure(
          ["roles", role, "write_targets", index],
          "写目标必须是档案内纯相对路径",
        );
    for (const [server, capabilities] of Object.entries(definition.mcp))
      for (const capability of capabilities)
        if (
          !Object.hasOwn(registry.mcp, server) ||
          !registry.mcp[server].capabilities.includes(capability)
        )
          failure(["roles", role, "mcp", server], "MCP能力没有已声明契约");
  }
  for (const [index, target] of manifest.dossier.layout.entries())
    if (!relative(target) || !target.endsWith("/"))
      failure(["dossier", "layout", index], "档案目录必须是纯相对目录");
  for (const target of Object.keys(manifest.dossier.templates))
    if (!relative(target) || target.endsWith("/"))
      failure(["dossier", "templates", target], "模板目标必须是档案内相对文件");
  for (const side of ["accepts", "sends"] as const)
    for (const value of manifest.delegations[side])
      if (!registry.delegations.includes(value))
        failure(["delegations", side], "委托类型没有已声明契约");
  for (const [card, definition] of Object.entries(manifest.cards))
    if (!Object.hasOwn(registry.tools, definition.tool))
      failure(["cards", card, "tool"], "卡片工具没有已声明契约");
}
export async function loadBenchBundle(options: {
  root?: string;
  benchId: string;
  registry: ToolRegistry;
}): Promise<LoadedBenchBundle> {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.benchId))
    failure(["id"], "工作台标识无效");
  const root = await rootPath(options.root ?? repositoryRoot),
    manifestFile = "benches/" + options.benchId + ".bench.yaml";
  const data = await bytes(root, manifestFile, 1048576),
    raw = parseDocumentStrict(decode(data, "manifest"), "manifest");
  const parsed = BenchManifest.safeParse(raw);
  if (!parsed.success)
    throw new BenchManifestError(
      parsed.error.issues.map((issue) => ({
        path: issue.path.length ? issue.path : ["manifest"],
        message: "清单字段无效",
      })),
    );
  const manifest = parsed.data;
  if (manifest.id !== options.benchId)
    failure(["id"], "工作台标识与文件不一致");
  checkedTree(options.registry, ["registry"]);
  const registry = ToolRegistry.safeParse(options.registry);
  if (!registry.success) failure(["registry"], "工具注册表字段无效");
  assertBenchSafety(manifest, registry.data);
  const referencedHashes: Record<string, string> = {
      [manifestFile]: sha(data),
    },
    prompts: Record<string, string> = {},
    schemas: Record<string,string> = {};
  const reference = async (file: string, prefix: string, maximum: number) => {
    if (!file.startsWith(prefix) || !relative(file))
      failure([file], "引用超出当前工作台bundle");
    const data = await bytes(root, file, maximum),
      text = decode(data, file);
    if (/\{(?:file|env):/i.test(text)) failure([file], "禁止配置引用插值");
    referencedHashes[file] = sha(data);
    return text;
  };
  for (const [role, definition] of Object.entries(manifest.roles)) {
    if (
      !/^prompts\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.md$/.test(definition.prompt)
    )
      failure(["roles", role, "prompt"], "提示词引用格式无效");
    prompts[role] = await reference(
      definition.prompt,
      "prompts/" + manifest.id + "/",
      32768,
    );
  }
  for (const definition of Object.values(manifest.cards)) {
    if (
      !/^schemas\/[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*\.json$/.test(
        definition.schema,
      )
    )
      failure(["cards"], "卡片schema引用格式无效");
    const text = await reference(
      definition.schema,
      "schemas/" + manifest.id + "/",
      131072,
    );
    try {
      checkedTree(JSON.parse(text));
      schemas[definition.schema] = text;
    } catch (error) {
      if (error instanceof BenchManifestError) throw error;
      failure([definition.schema], "卡片schema不是有效JSON");
    }
  }
  for (const file of Object.values(manifest.dossier.templates))
    await reference(file, "templates/" + manifest.id + "/", 131072);
  const registryHash = sha(canonical(registry.data));
  const digest = sha(canonical({ manifest, referencedHashes, registryHash }));
  return frozen({ manifest, digest, prompts, referencedHashes, registryHash, ...(Object.keys(schemas).length ? {schemas} : {}) });
}
