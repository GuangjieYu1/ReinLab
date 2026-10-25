import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  realpath,
  open,
  readdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
const Action = z.enum(["allow", "ask", "deny"]);
const Role = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    prompt: z.string().min(1).max(32768),
    toolGrants: z.record(
      z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
      z
        .object({
          risk: z.enum(["read", "write", "danger"]),
          permission: Action,
        })
        .strict()
    ),
    writeTargets: z.array(z.string()).max(64),
    steps: z.number().int().min(1).max(512),
    modelCap: z
      .object({
        cny: z.literal(0.05),
        rounds: z.literal(6),
        output_tokens: z.literal(256),
      })
      .strict()
      .optional(),
  })
  .strict();
const Options = z
  .object({
    root: z.string(),
    dossierId: z.string().uuid(),
    role: Role,
    model: z.string().regex(/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:/-]+$/),
    memory: z.string().max(131072),
    mcp: z
      .object({
        runId: z.string().uuid(),
        aliases: z.record(
          z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),
          z.array(z.string().regex(/^[a-z][a-z0-9_.-]+$/)).max(16)
        ),
        grants: z
          .array(
            z
              .object({
                name: z.string(),
                permission: z.enum(["allow", "ask"]),
                risk: z.enum(["read", "write", "danger"]),
              })
              .strict()
          )
          .max(128),
      })
      .strict()
      .optional(),
    pluginUrl: z.string().url(),
  })
  .strict();
export type RoleProject = Readonly<{
  directory: string;
  dossierDirectory: string;
  roleId: string;
}>;
const issued = new WeakMap<
  RoleProject,
  {
    files: Record<string, string>;
    root: string;
    pluginUrl: string;
    grants: Array<{ path: string; access: "read" | "write" }>;
    targets: string[];
  }
>();
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export const scopeDenied = () =>
  Object.assign(new Error("角色工作区或请求超出已授权范围。"), {
    code: "SCOPE_DENIED",
    status: 403,
  });
async function onlyManaged(dir: string) {
  if (
    (await readdir(dir)).some(
      (name) =>
        !["openscience.json", "AGENTS.md", ".role-policy.json"].includes(name)
    )
  )
    throw scopeDenied();
}
async function plainDirectory(dir: string) {
  const s = await lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink()) throw scopeDenied();
}
async function directory(parent: string, name: string) {
  const dir = path.join(parent, name);
  await plainDirectory(parent);
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  await plainDirectory(dir);
  return dir;
}
async function noGit(dir: string) {
  for (let p = dir; ; p = path.dirname(p)) {
    try {
      await lstat(path.join(p, ".git"));
      throw scopeDenied();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (p === path.dirname(p)) break;
  }
}
async function bytes(file: string) {
  const h = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const s = await h.stat();
    if (!s.isFile() || s.nlink !== 1 || s.size > 262144) throw scopeDenied();
    return await h.readFile();
  } finally {
    await h.close();
  }
}
async function managed(file: string, text: string) {
  try {
    const h = await open(file, "wx", 0o600);
    try {
      await h.writeFile(text);
      await h.sync();
    } finally {
      await h.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  if (digest(await bytes(file)) !== digest(text)) throw scopeDenied();
}
async function grantPath(root: string, target: string) {
  for (
    let current = root,
      parts = path.relative(root, target).split(path.sep),
      i = 0;
    i < parts.length;
    i++
  ) {
    current = path.join(current, parts[i]);
    try {
      const s = await lstat(current);
      if (s.isSymbolicLink() || (i < parts.length - 1 && !s.isDirectory()))
        throw scopeDenied();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  }
}
export async function requiredRolePlugin(project: RoleProject) {
  await assertRoleProject(project);
  return issued.get(project)!.pluginUrl;
}
export async function roleFilesystemGrants(project: RoleProject) {
  await assertRoleProject(project);
  return issued.get(project)!.grants.map((grant) => ({ ...grant }));
}
export async function assertRoleProject(project: RoleProject): Promise<void> {
  const state = issued.get(project);
  if (!state) throw scopeDenied();
  try {
    await onlyManaged(project.directory);
    await noGit(project.directory);
    for (let dir = project.directory; ; dir = path.dirname(dir)) {
      await plainDirectory(dir);
      if (dir === state.root) break;
      if (!dir.startsWith(state.root + path.sep)) throw scopeDenied();
    }
    await plainDirectory(project.dossierDirectory);
    if ((await realpath(project.dossierDirectory)) !== project.dossierDirectory)
      throw scopeDenied();
    for (const grant of state.grants)
      await grantPath(project.dossierDirectory, grant.path);
    for (const target of state.targets)
      await grantPath(
        project.dossierDirectory,
        path.resolve(project.dossierDirectory, target)
      );
    for (const [name, hash] of Object.entries(state.files))
      if (digest(await bytes(path.join(project.directory, name))) !== hash)
        throw scopeDenied();
  } catch {
    throw scopeDenied();
  }
}
export const RoleProjectRequest = Options.omit({ root: true, pluginUrl: true });
export type RoleOptions = z.infer<typeof Options>;
function canonicalRole(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalRole).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonicalRole(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function roleDefinitionHash(raw: unknown) {
  return digest(canonicalRole(Options.parse(raw)));
}
export function versionRoleOptions(raw: unknown): RoleOptions {
  try {
    const input = Options.parse(raw);
    return {
      ...input,
      role: {
        ...input.role,
        id:
          input.role.id.slice(0, 28) +
          "--" +
          roleDefinitionHash(input).slice(0, 32),
      },
    };
  } catch {
    throw scopeDenied();
  }
}
/** Pure content contract shared by the controller and the account's fixed store. */
export function planRoleProject(raw: unknown) {
  try {
    const input = Options.parse(raw);
    if (!path.isAbsolute(input.root) || path.resolve(input.root) !== input.root)
      throw scopeDenied();
    const root = input.root;
    const plugin = new URL(input.pluginUrl);
    if (plugin.protocol !== "file:" || plugin.search || plugin.hash)
      throw scopeDenied();
    for (const target of input.role.writeTargets) {
      const clean = target.replace(/\/$/, "");
      if (
        !/^[a-zA-Z0-9_./-]+$/.test(clean) ||
        path.isAbsolute(clean) ||
        clean
          .split("/")
          .some(
            (p) =>
              !p ||
              p === "." ||
              p === ".." ||
              [
                ".git",
                "AGENTS.md",
                "CLAUDE.md",
                "CONTEXT.md",
                "openscience.json",
              ].includes(p)
          )
      )
        throw scopeDenied();
    }

    const dossierDirectory = path.join(root, "dossiers", input.dossierId);
    const dir = path.join(root, "roles", input.dossierId, input.role.id);
    const permission: Record<string, string | Record<string, string>> = {
      "*": "deny",
    };
    const tools: Record<string, { risk: string; permission: string }> = {};
    const editors = ["edit", "write", "patch", "apply_patch", "multiedit"];
    let editAction = "deny";
    for (const [name, grant] of Object.entries(input.role.toolGrants).sort(
      ([a], [b]) => a.localeCompare(b)
    )) {
      const action =
        grant.risk === "danger" || name === "task" || editors.includes(name)
          ? "deny"
          : grant.permission;
      tools[name] = { ...grant, permission: action };
      if (editors.includes(name)) {
        if (action === "allow" || (action === "ask" && editAction === "deny"))
          editAction = action;
        continue;
      }
      permission[name] = action;
    }
    if (input.role.toolGrants.read && tools.read.permission !== "deny")
      permission.read = {
        "*": "deny",
        [path.join(dir, "AGENTS.md")]: tools.read.permission,
        [dossierDirectory + "/*"]: tools.read.permission,
      };
    permission.edit = {
      "*": "deny",
      ...Object.fromEntries(
        input.role.writeTargets.map((t) => [
          path.relative(dir, path.join(dossierDirectory, t)) +
            (t.endsWith("/") ? "/*" : ""),
          editAction,
        ])
      ),
    };
    permission.external_directory = {
      "*": "deny",
      [dossierDirectory + "/*"]: "allow",
    };
    permission.task = "deny";
    if (input.mcp) {
      permission.reinlab_mcp_approval = "ask";
      tools.reinlab_mcp_approval = { risk: "write", permission: "ask" };
      for (const grant of input.mcp.grants) {
        const key = "reinlab_" + grant.name.replaceAll(".", "_");
        permission[key] = "allow";
        tools[key] = {
          risk: grant.risk,
          permission: grant.risk === "danger" ? "ask" : "allow",
        };
      }
    }
    const config =
      JSON.stringify(
        {
          ...(input.mcp
            ? {
                mcp: Object.fromEntries(
                  [
                    ...new Set(
                      input.mcp.grants.map((g) => g.name.split(".")[0])
                    ),
                  ].map((server) => [
                    "reinlab_" + server,
                    {
                      type: "local",
                      command: [
                        "node",
                        root === "/data" &&
                        input.pluginUrl ===
                          "file:///opt/reinlab/plugin/index.js"
                          ? "/services/account-runtime/mcp/client.mjs"
                          : fileURLToPath(
                              new URL(
                                "../../../../account-runtime/mcp/client.mjs",
                                import.meta.url
                              )
                            ),
                        path.join(
                          root,
                          "mcp-clients",
                          input.mcp!.runId + ".json"
                        ),
                        server,
                      ],
                      enabled: true,
                    },
                  ])
                ),
              }
            : {}),
          default_agent: "research",
          ...(input.role.modelCap
            ? {
                enabled_providers: ["deepseek"],
                small_model: input.model,
                provider: {
                  deepseek: {
                    options: {
                      apiKey: "reinlab-clarify-no-secret",
                      baseURL: "https://reinlab-clarify.invalid/v1",
                      includeUsage: true,
                    },
                    models: {
                      "deepseek-v4-flash": {
                        id: "deepseek-flash",
                        limit: { context: 1000000, output: 256 },
                        options: { thinking: { type: "disabled" } },
                      },
                    },
                  },
                },
              }
            : {}),
          agent: {
            ...(input.role.modelCap ? { title: { disable: true } } : {}),
            research: {
              description: "ReinLab " + input.role.id,
              mode: "primary",
              prompt: input.role.prompt,
              model: input.model,
              steps: input.role.steps,
              permission,
            },
          },
        },
        null,
        2
      ) + "\n";
    if (/\{(?:file|env):/i.test(config)) throw scopeDenied();
    const memory =
      "# ReinLab / " + input.role.id + "\n\n" + input.memory + "\n";
    const policy =
      JSON.stringify(
        {
          schemaVersion: 1,
          requiredPluginUrl: input.pluginUrl,
          roleId: input.role.id,
          directory: dir,
          dossierDirectory,
          tools,
          writeTargets: input.role.writeTargets,
          ...(input.role.modelCap ? { modelCap: input.role.modelCap } : {}),
          ...(input.mcp ? { mcp: input.mcp } : {}),
          configSha256: digest(config),
          memorySha256: digest(memory),
        },
        null,
        2
      ) + "\n";
    const content = {
      "openscience.json": config,
      "AGENTS.md": memory,
      ".role-policy.json": policy,
    };

    const project = Object.freeze({
      directory: dir,
      dossierDirectory,
      roleId: input.role.id,
    });
    if (Object.values(content).some((text) => Buffer.byteLength(text) > 262144))
      throw scopeDenied();
    return {
      input,
      project,
      files: content,
      hashes: Object.fromEntries(
        Object.entries(content).map(([name, text]) => [name, digest(text)])
      ),
      grants: [
        { path: dossierDirectory, access: "read" as const },
        ...(editAction === "deny"
          ? []
          : input.role.writeTargets.map((t) => ({
              path: path.resolve(dossierDirectory, t),
              access: "write" as const,
            }))),
      ],
      pluginUrl: input.pluginUrl,
    };
  } catch {
    throw scopeDenied();
  }
}
export async function prepareRoleProject(raw: unknown): Promise<RoleProject> {
  try {
    // Validate all content before touching the store. The host plan and remote
    // receipt use exactly these bytes; no server-selected replacement policy.
    const parsed = planRoleProject(raw);
    await plainDirectory(parsed.input.root);
    const root = await realpath(parsed.input.root);
    await noGit(root);
    const plan = planRoleProject({ ...parsed.input, root });
    const { input, project } = plan;
    const dossiers = await directory(root, "dossiers");
    await directory(dossiers, input.dossierId);
    const roles = await directory(root, "roles");
    const parent = await directory(roles, input.dossierId);
    let exists = false;
    try {
      await plainDirectory(project.directory);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!exists) {
      const staging = await mkdtemp(
        path.join(parent, "." + input.role.id + "-")
      );
      try {
        for (const [name, text] of Object.entries(plan.files))
          await managed(path.join(staging, name), text);
        try {
          await rename(staging, project.directory);
        } catch (error) {
          if (
            !["EEXIST", "ENOTEMPTY"].includes(
              (error as NodeJS.ErrnoException).code ?? ""
            )
          )
            throw error;
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    issued.set(project, {
      root,
      pluginUrl: plan.pluginUrl,
      grants: plan.grants,
      targets: input.role.writeTargets,
      files: plan.hashes,
    });
    await assertRoleProject(project);
    return project;
  } catch {
    throw scopeDenied();
  }
}

/** Read-only recovery: missing or changed role files are denied, never created. */
export async function verifyRoleProject(raw: unknown): Promise<RoleProject> {
  try {
    // Validate all content before touching the store. The host plan and remote
    // receipt use exactly these bytes; no server-selected replacement policy.
    const parsed = planRoleProject(raw);
    await plainDirectory(parsed.input.root);
    const root = await realpath(parsed.input.root);
    await noGit(root);
    const plan = planRoleProject({ ...parsed.input, root });
    const { input, project } = plan;
    issued.set(project, {
      root,
      pluginUrl: plan.pluginUrl,
      grants: plan.grants,
      targets: input.role.writeTargets,
      files: plan.hashes,
    });
    await assertRoleProject(project);
    return project;
  } catch {
    throw scopeDenied();
  }
}

/** Called only behind the account entrypoint's existing authentication guard. */
export async function prepareAccountRole(
  raw: unknown,
  fixed: { root: string; pluginUrl: string; accountId: string },
  readOnly = false
) {
  try {
    const input = RoleProjectRequest.parse(raw);
    const accountId = z.string().uuid().parse(fixed.accountId);
    const options = { ...input, root: fixed.root, pluginUrl: fixed.pluginUrl };
    const project = await (readOnly ? verifyRoleProject : prepareRoleProject)(
      options
    );
    const plan = planRoleProject(options);
    await assertRoleProject(project);
    return {
      schemaVersion: 1 as const,
      accountId,
      ...project,
      hashes: plan.hashes,
      pluginUrl: plan.pluginUrl,
    };
  } catch {
    throw scopeDenied();
  }
}
