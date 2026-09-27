import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ResearchLab from './ResearchRecords';

describe('parallel research lab surface', () => {
  it('renders the standalone research hierarchy and accessible interaction controls', () => {
    const markup = renderToStaticMarkup(<ResearchLab archiveName="文献与实验" reduced onBack={() => {}} />);
    expect(markup).toContain('class="research-lab research-reduced"');
    expect(markup).toContain('class="research-lab-header"');
    expect(markup).toContain('class="research-lab-main"');
    expect(markup).toContain('class="research-state-rail"');
    expect(markup).toContain('class="research-forum"');
    expect(markup).toContain('SHARED STATE');
    expect(markup).toContain('DISCUSSION');
    expect(markup).toContain('EXPERIMENTS');
    expect(markup).toContain('ARCHITECTURE');
    expect(markup).toContain('OPTIMIZER');
    expect(markup).toContain('SCHEDULE');
    expect(markup).toContain('Champion');
    expect(markup).toContain('94.2');
    expect(markup).toContain('KEEP');
    expect(markup).toContain('REJECT');
    expect(markup).toContain('aria-label="保存研究手记"');
    expect(markup).toContain('aria-label="导出研究记录"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('预设讨论示例，非实时 AI 输出');
    expect(markup).toContain('固定样例 · 未连接执行器');
    expect(markup).not.toContain('沉浸课堂');
    expect(markup).not.toContain('选择研究档案');
  });

  it('offers archive selection only to callers which provide an archive-change callback', () => {
    const markup = renderToStaticMarkup(<ResearchLab archiveName="方法与证据" reduced onBack={() => {}} onArchiveChange={() => {}} />);
    expect(markup).toContain('选择研究档案');
    expect(markup).toContain('<select');
    expect(markup).toContain('value="方法与证据" selected=""');
    expect(markup).toContain('value="文献与实验"');
    expect(markup).toContain('value="研究笔记"');
  });

  it('keeps arbitrary archive names as text and accepts a parent-owned sound control', () => {
    const markup = renderToStaticMarkup(<ResearchLab archiveName="<script>实验</script>" reduced onBack={() => {}} soundControl={<button>声音控制</button>} />);
    expect(markup).toContain('&lt;script&gt;实验&lt;/script&gt;');
    expect(markup).not.toContain('<script>实验</script>');
    expect(markup).toContain('声音控制');
    expect(markup).toContain('写下研究手记');
  });
});
