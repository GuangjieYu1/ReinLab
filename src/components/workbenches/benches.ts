import { entryWorkbenches, type EntryWorkbench } from '../cinematic/entryWorkbenches';

export type BenchId = 'curriculum' | 'research' | 'engineering' | 'creative' | 'automation' | 'data' | 'exploration';
export const BENCHES: BenchId[] = ['curriculum', 'research', 'engineering', 'creative', 'automation', 'exploration', 'data'];
export const CODES: Record<BenchId | 'curriculum', string> = { curriculum: 'CURR', research: 'RSCH', engineering: 'ENGR', creative: 'CRTV', automation: 'AUTO', data: 'DATA', exploration: 'EXPL' };
export const fileNo = (index: number) => `X—${String(index + 13).padStart(3, '0')}`;

export const benchInfo = (id: BenchId): EntryWorkbench => entryWorkbenches.find(item => item.id === id)!;

/** What each workbench's files are, in its own words. */
export const FILE_NOUN: Record<BenchId, string> = { curriculum: '课程', research: '研究课题', engineering: '工作区', creative: '影片项目', automation: '流程分组', data: '数据集', exploration: '旅程' };
