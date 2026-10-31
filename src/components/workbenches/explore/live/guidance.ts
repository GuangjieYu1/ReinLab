// 引导词兼容：第一版是字符串，第二版每句带稳定 id 和姿势（design/prd/10-explore-v2-contract.md）。
import type { GuidanceLine, Stop } from '../../../../../packages/contracts/src/explore';

export function guidanceLines(detail: Stop['detail'] | undefined): GuidanceLine[] {
  return (detail?.guidance ?? []).map((g, i) => typeof g === 'string' ? { id: `g${i}`, text: g, pose: null } : g);
}
export const firstGuidance = (detail: Stop['detail'] | undefined) => guidanceLines(detail)[0]?.text;
