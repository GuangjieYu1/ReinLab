import { expect, it, vi } from 'vitest';
import { createLiveInboxAdapter } from '../../../src/data/inbox-live';

it('supplied question answers cannot bypass sent, indeterminate or unknown approval fences', async () => {
  const decide = vi.fn();
  const adapter = createLiveInboxAdapter({ generation: () => 1, api: vi.fn(), decide, inbox: async () => ({ promotions: [], approvals: [
    { id: 'sent-question', kind: 'question', state: 'pending', sent: true },
    { id: 'unknown-question', kind: 'question', state: 'indeterminate', sent: false },
    { id: 'pending-question', kind: 'question', state: 'pending', sent: false },
  ] }) } as never);
  const view = await adapter.load(); expect(view.approvals[0].state).toBe('indeterminate');
  for (const id of ['sent-question', 'unknown-question', 'unloaded-question']) await expect(adapter.decideApproval(id, 'approve', [['Original label']])).rejects.toThrow();
  await expect(adapter.decideApproval('pending-question', 'approve')).rejects.toThrow();
  expect(decide).not.toHaveBeenCalled();
});

it('a stale question load cannot replace another account cache and only current exact answers reach the port', async () => {
  let generation = 1, finishOld!: (value: unknown) => void;
  const question = (id: string) => ({ id, kind: 'question', state: 'pending', sent: false, effects: [{ source: { type: 'question.asked' }, properties: { questions: [{ question: 'Choose', header: 'Scope', options: [{ label: ' Original label ', description: 'Original description' }], multiple: false, custom: false }] } }] });
  const inbox = vi.fn().mockImplementationOnce(() => new Promise(done => { finishOld = done; })).mockResolvedValueOnce({ promotions: [], approvals: [question('account-b-question')] });
  const decide = vi.fn().mockResolvedValue({});
  const adapter = createLiveInboxAdapter({ generation: () => generation, api: vi.fn(), decide, inbox } as never);
  const old = adapter.load(); const refused = expect(old).rejects.toThrow(); generation = 2;
  const current = await adapter.load(); finishOld({ promotions: [], approvals: [question('account-a-question')] }); await refused;
  expect(current.approvals[0].questions?.[0]).toEqual({ question: 'Choose', header: 'Scope', options: [{ label: ' Original label ', description: 'Original description' }], multiple: false, custom: false });
  await expect(adapter.decideApproval('account-a-question', 'approve', [[' Original label ']])).rejects.toThrow(); expect(decide).not.toHaveBeenCalled();
  const answers = [[' Original label ']]; await adapter.decideApproval('account-b-question', 'approve', answers);
  expect(decide.mock.calls[0][2].answers === answers).toBe(true);
  generation = 3; await expect(adapter.decideApproval('account-b-question', 'approve', answers)).rejects.toThrow(); expect(decide).toHaveBeenCalledTimes(1);
});
