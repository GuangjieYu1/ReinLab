import { z } from 'zod';
import { planRoleProject, scopeDenied, type RoleProject } from './role-project';

type Plan = ReturnType<typeof planRoleProject>;
const capabilities = new WeakMap<RoleProject, { plan: Plan; check: () => Promise<void> }>();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Receipt = z.object({ schemaVersion: z.literal(1), accountId: z.string().uuid(), directory: z.string(), dossierDirectory: z.string(), roleId: z.string(), pluginUrl: z.string(), hashes: z.object({ 'AGENTS.md': hash, 'openscience.json': hash, '.role-policy.json': hash }).strict() }).strict();
const unavailable = () => Object.assign(new Error('账户角色存储暂时不可用。'), { code: 'OS_UNAVAILABLE', status: 503 });

async function smallJson(response: Response) {
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw unavailable(); }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { reader.releaseLock(); }
}

/** Authenticated fixed account store, never a general filesystem/command API. */
export class RemoteRoleStore {
  private readonly url: string;
  private readonly token: string;
  private readonly accountId: string;
  constructor(options: { baseUrl: string; token: string; accountId: string; readOnly?: boolean }, private readonly transport: typeof fetch = fetch) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw scopeDenied();
    this.accountId = z.string().uuid().parse(options.accountId); this.token = options.token;
    this.url = url.origin + (options.readOnly ? '/reinlab/roles/verify' : '/reinlab/roles/prepare');
  }
  private async check(plan: Plan) {
    try {
      const { root: _root, pluginUrl: _plugin, ...body } = plan.input;
      const response = await this.transport(this.url, { method: 'POST', headers: { authorization: 'Bearer ' + this.token, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) { await response.body?.cancel(); if (response.status === 403) throw scopeDenied(); throw unavailable(); }
      const receipt = Receipt.parse(await smallJson(response));
      if (receipt.accountId !== this.accountId || receipt.directory !== plan.project.directory || receipt.dossierDirectory !== plan.project.dossierDirectory || receipt.roleId !== plan.project.roleId || receipt.pluginUrl !== plan.pluginUrl || Object.entries(plan.hashes).some(([name, value]) => receipt.hashes[name as keyof typeof receipt.hashes] !== value)) throw scopeDenied();
    } catch (error) {
      if ((error as { code?: string })?.code === 'SCOPE_DENIED') throw error;
      throw unavailable();
    }
  }
  async prepare(raw: unknown): Promise<RoleProject> {
    const plan = planRoleProject(raw);
    if (plan.input.root !== '/data' || plan.pluginUrl !== 'file:///opt/reinlab/plugin/index.js') throw scopeDenied();
    await this.check(plan);
    capabilities.set(plan.project, { plan, check: () => this.check(plan) });
    return plan.project;
  }
}
export function isRemoteProject(project: RoleProject) { return capabilities.has(project); }
export async function assertRemoteProject(project: RoleProject) {
  const state = capabilities.get(project); if (!state) throw scopeDenied(); await state.check();
}
export async function remoteProjectGrants(project: RoleProject) {
  await assertRemoteProject(project); return capabilities.get(project)!.plan.grants.map(grant => ({ ...grant }));
}
export async function remoteProjectPlugin(project: RoleProject) {
  await assertRemoteProject(project); return capabilities.get(project)!.plan.pluginUrl;
}
