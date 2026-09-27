import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import LearningClassroom, { MathPager } from './LearningClassroom';
import { subjectIds, subjectInfo } from './learningState';

describe('one archive, one classroom', () => {
  for (const id of subjectIds) {
    it(`opens only ${id}, with its own persistent notebook`, () => {
      const markup = renderToStaticMarkup(<LearningClassroom initialSubject={id} reduced soundControl={null} onBack={() => {}} onMediaPlaying={() => {}} />);
      expect(markup).toContain(`${subjectInfo[id].name}沉浸课堂`);
      expect(markup).toContain(`${subjectInfo[id].name}手记`);
      expect(markup).toContain(subjectInfo[id].goal);
      expect(markup).toContain('class="learning-note-shell"');
      expect(markup).toContain('aria-controls="learning-notebook"');
      expect(markup).toContain('aria-label="存入手记"');
      expect(markup).not.toContain('aria-label="选择课堂"');
      expect(markup).not.toContain('class="rl-subjects"');
      expect(markup).not.toContain('打开原线性代数档案');
      for (const other of subjectIds.filter(other => other !== id)) {
        expect(markup).not.toContain(subjectInfo[other].title);
        expect(markup).not.toContain(subjectInfo[other].goal);
      }
    });
  }
});

describe('fixed math navigation', () => {
  it('always renders previous and next controls independently of the lesson pane', () => {
    const first = renderToStaticMarkup(<MathPager page={0} onPage={() => {}} />);
    const middle = renderToStaticMarkup(<MathPager page={2} onPage={() => {}} />);
    const last = renderToStaticMarkup(<MathPager page={5} onPage={() => {}} />);
    for (const markup of [first, middle, last]) {
      expect(markup).toContain('aria-label="上一页数学讲义"');
      expect(markup).toContain('aria-label="下一页数学讲义"');
    }
    expect(first).toMatch(/aria-label="上一页数学讲义"[^>]*disabled/);
    expect(middle).toContain('群的定义');
    expect(middle).toContain('03 / 06');
    expect(last).toMatch(/aria-label="下一页数学讲义"[^>]*disabled/);
  });
});
