import { describe, expect, it } from 'vitest';
import { buildTree, defaultTemplate, initialTurns, isTemplate, newTurn, platforms } from './model';

describe('conversation tree', () => {
  it('keeps a complete turn as one node, not a node per slide or tool', () => {
    const turns = initialTurns('learning');
    expect(turns).toHaveLength(4);
    expect(turns.every(t => !!t.prompt && !!t.body)).toBe(true);
  });
  it('builds depth-first ordering without losing sibling branches', () => {
    expect(buildTree(initialTurns('learning')).map(({ turn, depth }) => [turn.id, depth]))
      .toEqual([['01', 0], ['02', 1], ['03', 2], ['04', 2]]);
  });
  it('adds a new sibling from historical context and preserves existing turns', () => {
    const original = initialTurns('learning');
    const added = newTurn(original, '02', '从另一个角度解释');
    expect(added.parent).toBe('02');
    expect(added.id).toBe('05');
    expect(added.status).toBe('running');
    expect(original).toHaveLength(4);
    expect(buildTree([...original, added]).filter(x => x.depth === 2)).toHaveLength(3);
  });
  it('appends from a leaf without creating a sibling', () => {
    const original = initialTurns('learning');
    const added = newTurn(original, '04', '继续');
    expect(buildTree([...original, added]).at(-1)?.depth).toBe(3);
  });
  it('starts an empty conversation at node 01', () => {
    const added = newTurn([], null, '第一个问题');
    expect(added.id).toBe('01');
    expect(buildTree([added])).toEqual([{ turn: added, depth: 0 }]);
  });
  it('every platform contains a coherent example conversation', () => {
    for (const p of platforms) {
      const turns = initialTurns(p.id);
      expect(buildTree(turns)).toHaveLength(turns.length);
      expect(turns[0].parent).toBeNull();
      expect(new Set(turns.map(t => t.id)).size).toBe(turns.length);
    }
  });
});

describe('template validation and snapshotting', () => {
  it('accepts the standard template', () => expect(isTemplate(defaultTemplate)).toBe(true));
  it('rejects incomplete or incompatible saved values', () => {
    expect(isTemplate(null)).toBe(false);
    expect(isTemplate({ name: 'Broken' })).toBe(false);
    expect(isTemplate({ ...defaultTemplate, mode: 'video' })).toBe(false);
    expect(isTemplate({ ...defaultTemplate, modules: [null] })).toBe(false);
    expect(isTemplate({ ...defaultTemplate, platform: 'unknown' })).toBe(false);
  });
  it('editing a template does not mutate a project snapshot', () => {
    const projectTemplate = structuredClone(defaultTemplate);
    const edited = { ...defaultTemplate, modules: [...defaultTemplate.modules, '文献表'] };
    expect(projectTemplate.modules).not.toContain('文献表');
    expect(edited.modules).toContain('文献表');
  });
});
