// 跨台委托（design/prd/13-swarm-contract.md §6）：源台把问题交给群研。
// 弹窗里点「交给群研」就是用户的确认，所以发起和确认连着做；研究档案里先澄清、出计划，计划确认后才建队。
import { request } from './research-live';

export type DelegationStart = { delegationId: string; researchDossierId: string; runId: string };

export async function delegateToSwarm(input: { fromBench: string; fromDossierId: string; question: string; background?: string }): Promise<DelegationStart> {
  const made = await request('POST', '/v1/delegations', {
    fromBench: input.fromBench, fromDossierId: input.fromDossierId, question: input.question,
    ...(input.background ? { background: input.background } : {}),
  }) as { id: string };
  const started = await request('POST', `/v1/delegations/${made.id}/confirm`, {}) as { researchDossierId: string; runId: string };
  return { delegationId: made.id, ...started };
}

export const researchHref = (dossierId: string) => `/?preview=workbench&studio=research&file=1&dossier=${encodeURIComponent(dossierId)}`;
