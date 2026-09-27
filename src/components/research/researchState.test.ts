import { describe, expect, it } from 'vitest';
import {
  addResearchNote, BASELINE_SCORE, completeResearchDemo, decideResearchExperiment, freshResearch,
  isResearchStore, MAX_DEMO_ROUNDS, MAX_RESEARCH_NOTE_LENGTH, MAX_RESEARCH_NOTES,
  normalizeResearchArchive, researchChampion, researchDecision, researchExperiments,
  researchMarkdown, researchStorageKey, researchTrend,
} from './researchState';

describe('independent research state', () => {
  it('starts with six experiments, three lanes and an explicitly kept champion', () => {
    const state = freshResearch('文献与实验');
    expect(isResearchStore(state, '文献与实验')).toBe(true);
    const experiments = researchExperiments(state.round);
    expect(experiments).toHaveLength(6);
    expect(new Set(experiments.map(experiment => experiment.lane))).toEqual(new Set(['architecture', 'optimizer', 'schedule']));
    expect(researchChampion(state)?.id).toBe('EXP-004');
    expect(researchChampion(state)?.score).toBe(94.2);
    expect(researchDecision(state, experiments[5])).toBe('review');
  });

  it('scopes persistence and content to one archive, separately from classroom keys', () => {
    const first = freshResearch('文献与实验'), second = freshResearch('研究笔记');
    first.draft = '只在第一份研究档案中';
    expect(second.draft).toBe('');
    expect(isResearchStore(first, '研究笔记')).toBe(false);
    expect(researchStorageKey('文献与实验')).not.toBe(researchStorageKey('研究笔记'));
    expect(researchStorageKey('文献与实验')).toMatch(/^reinlab-research-lab-v1:/);
    expect(researchStorageKey('  文献与实验  ')).toBe(researchStorageKey('文献与实验'));
    expect(normalizeResearchArchive('   ')).toBe('文献与实验');
    expect(normalizeResearchArchive('A'.repeat(200))).toHaveLength(160);
  });

  it('produces fresh, immutable experiment descriptions for each read', () => {
    const first = researchExperiments();
    first[0].title = 'changed';
    expect(researchExperiments()[0].title).not.toBe('changed');
    expect(researchExperiments(Number.NaN)).toHaveLength(6);
    expect(researchExperiments(-5)).toHaveLength(6);
    expect(researchExperiments(100)).toHaveLength(18);
  });

  it('recomputes shared state after manual decisions without removing evidence', () => {
    const original = freshResearch('方法与证据');
    const changed = decideResearchExperiment(original, 'EXP-004', 'reject');
    expect(researchChampion(changed)?.id).toBe('EXP-002');
    expect(researchChampion(changed)?.score).toBe(93.4);
    expect(researchExperiments(changed.round)).toHaveLength(6);
    expect(original.decisions).toEqual({});
    const restored = decideResearchExperiment(changed, 'EXP-004', 'keep');
    expect(researchChampion(restored)?.score).toBe(94.2);
    expect(decideResearchExperiment(restored, 'missing-id', 'keep')).toBe(restored);
  });

  it('uses the baseline when no experiment is currently kept', () => {
    let state = freshResearch('方法与证据');
    for (const experiment of researchExperiments()) state = decideResearchExperiment(state, experiment.id, 'reject');
    expect(researchChampion(state)).toBeNull();
    expect(researchTrend(state).every(point => point.score === BASELINE_SCORE)).toBe(true);
  });

  it('runs bounded deterministic rounds and never overwrites a manual decision', () => {
    let state = decideResearchExperiment(freshResearch('文献与实验'), 'EXP-004', 'reject');
    const original = state;
    for (let round = 1; round <= MAX_DEMO_ROUNDS; round++) {
      state = completeResearchDemo(state);
      expect(state.round).toBe(round);
      expect(researchExperiments(state.round)).toHaveLength(6 + round * 3);
      expect(isResearchStore(state, '文献与实验')).toBe(true);
    }
    expect(state.decisions['EXP-004']).toBe('reject');
    expect(original.round).toBe(0);
    expect(completeResearchDemo(state)).toBe(state);
    expect(researchChampion(state)?.score).toBe(95.4);
    expect(researchExperiments(MAX_DEMO_ROUNDS)).toEqual(researchExperiments(MAX_DEMO_ROUNDS));
  });

  it('builds a monotonic historical best from current kept decisions', () => {
    const state = completeResearchDemo(freshResearch('研究笔记'));
    const points = researchTrend(state);
    expect(points).toHaveLength(10);
    expect(points[0]).toEqual({ id: 'baseline', score: BASELINE_SCORE });
    points.forEach((point, index) => {
      if (index > 0) expect(point.score).toBeGreaterThanOrEqual(points[index - 1].score);
    });
    expect(points.at(-1)?.score).toBe(researchChampion(state)?.score);
  });
});

describe('research notes and data validation', () => {
  it('records the actual user text and experiment reference without generating an answer', () => {
    const state = freshResearch('研究笔记');
    state.draft = '  更低延迟是否值得牺牲 0.2 个百分点？  ';
    state.draftKind = 'question';
    const next = addResearchNote(state, { id: 'question-one', createdAt: 100 });
    expect(next.notes).toEqual([{ id: 'question-one', createdAt: 100, kind: 'question', text: '更低延迟是否值得牺牲 0.2 个百分点？', experimentId: 'EXP-004' }]);
    expect(next.draft).toBe('');
    expect(state.notes).toEqual([]);
    expect(state.draft).not.toBe('');
    expect(isResearchStore(next, '研究笔记')).toBe(true);
  });

  it('does not discard existing notes or drafts at the limit', () => {
    let state = freshResearch('研究笔记');
    for (let index = 0; index < MAX_RESEARCH_NOTES; index++) {
      state = addResearchNote({ ...state, draft: `观察 ${index}` }, { id: `note-${index}`, createdAt: index });
    }
    expect(state.notes).toHaveLength(MAX_RESEARCH_NOTES);
    const full = { ...state, draft: '请勿丢失这份草稿' };
    expect(addResearchNote(full, { id: 'too-many', createdAt: 100 })).toBe(full);
    expect(full.notes[0].text).toBe('观察 0');
    expect(full.draft).toBe('请勿丢失这份草稿');
  });

  it('bounds new note length and rejects empty text, duplicate ids and invalid timestamps', () => {
    const empty = freshResearch('研究笔记');
    expect(addResearchNote(empty, { id: 'empty', createdAt: 0 })).toBe(empty);
    const text = { ...empty, draft: 'a'.repeat(MAX_RESEARCH_NOTE_LENGTH + 10) };
    const one = addResearchNote(text, { id: 'one', createdAt: 1 });
    expect(one.notes[0].text).toHaveLength(MAX_RESEARCH_NOTE_LENGTH);
    const two = { ...one, draft: 'second' };
    expect(addResearchNote(two, { id: 'one', createdAt: 2 })).toBe(two);
    expect(addResearchNote(two, { id: 'two', createdAt: Number.NaN })).toBe(two);
    expect(addResearchNote(two, { id: 'two', createdAt: -1 })).toBe(two);
    expect(addResearchNote(two, { id: 'two', createdAt: Infinity })).toBe(two);
  });

  it('rejects malformed, oversized, wrong-archive and unknown-experiment state', () => {
    const good = freshResearch('文献与实验');
    for (const bad of [null, [], {}, 'bad', { ...good, version: 2 }, { ...good, archiveName: '研究笔记' },
      { ...good, round: -1 }, { ...good, round: 9 }, { ...good, round: .5 }, { ...good, selectedId: 'EXP-099' },
      { ...good, decisions: { 'EXP-999': 'keep' } }, { ...good, decisions: { 'EXP-004': 'running' } },
      { ...good, draft: 'a'.repeat(MAX_RESEARCH_NOTE_LENGTH + 1) }, { ...good, notes: new Array(41).fill({}) },
      { ...good, draftKind: 'answer' }]) expect(isResearchStore(bad, '文献与实验')).toBe(false);
  });

  it('rejects duplicate notes, impossible dates and invalid references in persisted notes', () => {
    const state = addResearchNote({ ...freshResearch('研究笔记'), draft: '真实用户手记' }, { id: 'note', createdAt: 100 });
    const note = state.notes[0];
    for (const notes of [[note, note], [{ ...note, experimentId: 'EXP-008' }], [{ ...note, text: '  ' }],
      [{ ...note, createdAt: Infinity }], [{ ...note, createdAt: 9e15 }], [{ ...note, kind: 'assistant' }],
      [{ ...note, text: 'a'.repeat(MAX_RESEARCH_NOTE_LENGTH + 1) }]]) {
      expect(isResearchStore({ ...state, notes }, '研究笔记')).toBe(false);
    }
  });

  it('exports decisions and original writing with a prominent simulation disclaimer', () => {
    const state = addResearchNote({ ...freshResearch('研究笔记'), draft: '我的独立观察。' }, { id: 'note', createdAt: 0 });
    state.draft = '尚未提交的想法';
    const text = researchMarkdown(state);
    expect(text).toContain('我的独立观察。');
    expect(text).toContain('尚未提交的想法');
    expect(text).toContain('不是实际 AI 调用或训练结果');
    expect(text).toContain('EXP-004');
    expect(text).toContain('KEEP');
    expect(text).toContain('REJECT');
  });
});
