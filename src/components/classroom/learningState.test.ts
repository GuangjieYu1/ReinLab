import { describe, expect, it } from 'vitest';
import { addEvidence, describeScene, freshLearning, freshScene, isLearningStore, isScene, learningMarkdown, normalizeLongitude, period, restoreEvidence, subjectIds, transformPoint, updateScene } from './learningState';
import { archiveNames, nameFor } from '../cinematic/ArchiveField';
import { COURSE_KEY } from './courseState';

describe('native classroom persistence', () => {
  it('starts with six independent course records and keeps the old course key separate', () => {
    const store = freshLearning();
    expect(isLearningStore(store)).toBe(true);
    expect(subjectIds).toHaveLength(6);
    expect(COURSE_KEY).toBe('reinlab-course-linear-algebra-v1');
    store.subjects.math.scene.nodes[0][0] = 60;
    expect(store.subjects.physics.scene.nodes[0][0]).toBe(27);
  });
  it('replaces legacy demo course labels with the native OpenMAIC entry and keeps other lanes unchanged', () => {
    expect(nameFor({ lane: 1, row: 12 })).toBe('OpenMAIC 课程档案');
    expect(archiveNames[1]).toEqual(['OpenMAIC 课程档案']);
    expect(nameFor({ lane: 0, row: 4 })).toBe('方法与证据');
    expect(nameFor({ lane: 3, row: 31 })).toBe('城市观察');
  });
  it('isolates scene updates, notes, and drafts across courses', () => {
    const store = freshLearning(); store.subjects.math.note = '我的文字'; store.subjects.math.draft = '未发送的问题';
    const next = updateScene(store, 'math', { page: 3, angle: 180 });
    expect(next.subjects.math.scene.page).toBe(3);
    expect(next.subjects.math.note).toBe('我的文字');
    expect(next.subjects.physics.scene.page).toBe(0);
    expect(store.subjects.math.scene.page).toBe(0);
  });
  it('freezes evidence snapshots and restores only the object, not the current notebook', () => {
    let s = freshLearning(); const scene = freshScene();
    s = addEvidence(s, 'math', { id: 'one', at: 100, kind: 'snapshot', text: '操作记录', scene });
    scene.nodes[0][0] = 70;
    expect(s.subjects.math.evidence[0].scene.nodes[0][0]).toBe(27);
    s.subjects.math.note = '后来的手动编辑'; s.subjects.math.draft = '草稿';
    s = updateScene(s, 'math', { page: 5 });
    s = restoreEvidence(s, 'math', 'one');
    expect(s.subjects.math.scene.page).toBe(0);
    expect(s.subjects.math.note).toBe('后来的手动编辑');
    expect(s.subjects.math.draft).toBe('草稿');
    expect(s.subjects.math.evidence).toHaveLength(1);
    expect(restoreEvidence(s, 'math', 'missing')).toBe(s);
  });
  it('bounds evidence without deleting editable notes or changing other courses', () => {
    let s = freshLearning();
    for (let i = 0; i < 65; i++) s = addEvidence(s, 'systems', { id: String(i), at: i, kind: 'snapshot', text: 'trace', scene: freshScene() });
    expect(s.subjects.systems.evidence).toHaveLength(60);
    expect(s.subjects.systems.evidence[0].id).toBe('5');
    expect(s.subjects.math.evidence).toHaveLength(0);
  });
  it('rejects corrupted, unbounded and invalid state', () => {
    for (const value of [null, {}, { version: 99 }, [], 'bad']) expect(isLearningStore(value)).toBe(false);
    expect(isScene({ ...freshScene(), mass: -1 })).toBe(false);
    expect(isScene({ ...freshScene(), step: 11 })).toBe(false);
    expect(isScene({ ...freshScene(), lon: Infinity })).toBe(false);
    expect(isScene({ ...freshScene(), nodes: [[0, 0]] })).toBe(false);
    expect(isScene({ ...freshScene(), picks: [1, 1] })).toBe(false);
    expect(isScene({ ...freshScene(), strokes: [[[0, 100]]] })).toBe(false);
    const s = freshLearning(); s.subjects.math.evidence.push({ id: 'x', at: 1, text: 'broken', kind: 'snapshot', scene: { ...freshScene(), page: 100 } });
    expect(isLearningStore(s)).toBe(false);
  });
  it('exports user edits and clearly labels demo evidence', () => {
    const s = freshLearning(); s.subjects.math.note = '我自己的理解';
    expect(learningMarkdown(s, 'math')).toContain('我自己的理解');
    expect(learningMarkdown(s, 'math')).toContain('未连接真实教授');
    expect(describeScene('math', { ...freshScene(), page: 4, proof: 3 })).toContain('不计为独立完成');
    expect(describeScene('math', { ...freshScene(), page: 3, angle: 180 })).toContain('R 固定为 90°');
  });
});
describe('teaching calculations', () => {
  it('uses the intended operation order and provides a genuine counterexample', () => {
    expect(transformPoint([-1, 1], 90, 'RF')).toEqual([1, -1]);
    expect(transformPoint([-1, 1], 90, 'FR')).toEqual([-1, 1]);
    for (const p of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as [number, number][]) expect(transformPoint(p, 180, 'RF')).toEqual(transformPoint(p, 180, 'FR'));
  });
  it('uses a square root period and wraps globe longitude', () => {
    expect(period(2, 10) / period(.5, 10)).toBeCloseTo(2);
    expect(normalizeLongitude(200)).toBe(-160);
    expect(normalizeLongitude(-200)).toBe(160);
    expect(normalizeLongitude(720)).toBe(0);
  });
});
