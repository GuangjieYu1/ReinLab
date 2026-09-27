import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ResearchLab from './ResearchLab';
import { nextResearchEvent, projectResearchEvents, workflowPosition, workflowScript } from './researchWorkflow';

describe('event-driven research prototype', () => {
  it('preserves the sparse scene without pretending to have initial research results', () => {
    const html = renderToStaticMarkup(<ResearchLab archiveName="文献与实验" reduced onBack={() => {}} />);
    for (const text of ['SHARED STATE', 'Champion', 'Log', 'Forum', 'DISCUSSION', 'architecture', 'optimizer', 'schedule', '人工确认', '历史回放', '本地事件模拟']) expect(html).toContain(text);
    expect(html.match(/aria-label="研究员 a/g)).toHaveLength(9);
    expect(html).toContain('等待候选核验');
    expect(html).not.toContain('0.4526');
    expect(html).not.toContain('假设、实验、证据。');
  });
  it('halts manual dispatch at the decision boundary and records approval provenance', () => {
    const events = workflowScript.slice(0, 10);
    expect(nextResearchEvent(events, 'manual')).toBeNull();
    expect(nextResearchEvent(events, 'manual', true)?.approval).toBe('manual');
    expect(nextResearchEvent(events, 'auto')?.approval).toBe('auto');
    expect(nextResearchEvent(workflowScript, 'auto')).toBeNull();
  });
  it('separates execution from verdict and checks candidates before updating champion', () => {
    const beforeCheck = projectResearchEvents(workflowScript.slice(0, 6));
    expect(beforeCheck.champion).toBeUndefined();
    expect(beforeCheck.tasks.find(t => t.id === 'E07')).toMatchObject({ execution: 'completed', verdict: 'unsupported' });
    expect(beforeCheck.tasks.find(t => t.id === 'E09')).toMatchObject({ execution: 'blocked', verdict: 'pending' });
    expect(beforeCheck.tasks.find(t => t.id === 'E09')?.score).toBeUndefined();
    expect(projectResearchEvents(workflowScript.slice(0, 7)).champion?.id).toBe('E08');
    expect(projectResearchEvents(workflowScript.slice(0, 13)).champion?.id).toBe('E08');
    expect(projectResearchEvents(workflowScript).champion?.id).toBe('E11');
  });
  it('only summons related agents and turns the decision into a new task', () => {
    const discussion = projectResearchEvents(workflowScript.slice(0, 10));
    expect(discussion.participants).toEqual([2, 5, 3]);
    expect(workflowPosition(2, discussion).y).toBeLessThan(350);
    expect(workflowPosition(7, discussion).y).toBe(463);
    expect(discussion.tasks.some(t => t.id === 'E11')).toBe(false);
    const joint = projectResearchEvents(workflowScript.slice(0, 12));
    expect(joint.discussion).toBe(false);
    expect(joint.tasks.find(t => t.id === 'E11')?.agents).toEqual([2, 5, 3]);
    expect(workflowPosition(5, joint).x).toBeLessThan(550);
  });
  it('projects history without modifying the current events or their objects', () => {
    const before = JSON.stringify(workflowScript);
    const historical = projectResearchEvents(workflowScript.slice(0, 4));
    expect(historical.posts).toHaveLength(0);
    expect(historical.champion).toBeUndefined();
    expect(projectResearchEvents(workflowScript).reportReady).toBe(true);
    expect(JSON.stringify(workflowScript)).toBe(before);
  });
  it('does not promote a blocked or unsupported task through verification', () => {
    for (const id of ['E07', 'E09']) expect(projectResearchEvents([...workflowScript.slice(0, 6), { id: 'bad', kind: 'verification', title: 'test', target: id }]).champion).toBeUndefined();
  });
  it('escapes archive names and preserves sound controls', () => {
    const html = renderToStaticMarkup(<ResearchLab archiveName="<script>test</script>" reduced onBack={() => {}} soundControl={<button>声音控制</button>} />);
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>test'); expect(html).toContain('声音控制');
  });
});
