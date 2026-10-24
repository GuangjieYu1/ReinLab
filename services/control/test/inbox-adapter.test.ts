import { it, expect, vi } from 'vitest';
import { createLiveInboxAdapter } from '../../../src/data/inbox-live';
const source = { bench:'research', dossierId:'dossier-a', dossierTitle:'真实来源', runId:'run-a', roleId:'research-read' };
const promotion = { id:'promotion-a', target:'L4.knowledge', items:[{ key:'fact', value:{ verified:true }, evidence:['event:17'], supersedes:'memory-a' }], reason:'来源已核对', createdAt:'2026-10-24T00:00:00Z', expiresAt:'2026-10-25T00:00:00Z', source };
it('Claude InboxAdapter maps real source, original evidence and replacement without inventing a destination', async () => {
  const api = vi.fn(async (path:string) => path.includes('/superseded/') ? { id:'memory-a',key:'fact',value:'old' } : {ref:'event:17',event:{dossierId:source.dossierId,runId:source.runId,kind:'message',action:'user_verified',payload:{text:'原始对话片段'},at:'2026-10-24T00:00:00Z'}});
  const adapter = createLiveInboxAdapter({ generation:()=>1, api, decide:vi.fn(), inbox:async()=>({promotions:[promotion],approvals:[{id:'approval-a',kind:'permission',runId:'run-a',state:'pending',sent:false,risk:'write',title:'写入',effects:{operation:'files.write',path:'findings/actual.md'},source}]}) } as any);
  const loaded = await adapter.load();expect(loaded.promotions[0]).toEqual(promotion);expect(loaded.approvals[0].effects.every(x=>typeof x==='string')).toBe(true);
  expect(await adapter.evidence('event:17')).toMatchObject({ref:'event:17',quote:'原始对话片段',at:'2026-10-24T00:00:00Z'});
  expect((await adapter.evidence('event:17')).href).toBeUndefined();
  expect(await adapter.superseded('memory-a')).toEqual({id:'memory-a',key:'fact',value:'old'});
  expect(api.mock.calls[0][0]).toBe('/v1/promotions/promotion-a/evidence/17');
  await expect(adapter.evidence('event:18')).rejects.toThrow();expect(await adapter.superseded('unlisted-memory')).toBeNull();
});
it('stale session/load cannot expose old account evidence or approve unknown/question with a fabricated answer', async () => {
  let generation=1;const decide=vi.fn(),api=vi.fn();
  const adapter=createLiveInboxAdapter({generation:()=>generation,api,decide,inbox:async()=>({promotions:[promotion],approvals:[{id:'unknown',state:'indeterminate',kind:'permission'},{id:'question',state:'pending',kind:'question'}]})} as any);
  await adapter.load();await expect(adapter.decideApproval('unknown','approve')).rejects.toThrow();await expect(adapter.decideApproval('question','approve')).rejects.toThrow();expect(decide).not.toHaveBeenCalled();
  await adapter.decideApproval('question','reject');expect(decide).toHaveBeenCalledWith('approval','question',{decision:'reject',scope:'once'});
  generation=2;await expect(adapter.evidence('event:17')).rejects.toThrow();await expect(adapter.decidePromotion('promotion-a',{decision:'approve'})).rejects.toThrow();expect(api).not.toHaveBeenCalled();
});
it('failed decisions propagate so the component cannot paint success; exact user intent reaches existing idempotency',async()=>{
 const decide=vi.fn().mockRejectedValueOnce(Error('reply lost')).mockResolvedValueOnce({});const adapter=createLiveInboxAdapter({generation:()=>1,api:vi.fn(),decide,inbox:async()=>({promotions:[promotion],approvals:[]})} as any);await adapter.load();
 await expect(adapter.decidePromotion('promotion-a',{decision:'approve'})).rejects.toThrow('reply lost');await adapter.decidePromotion('promotion-a',{decision:'approve'});expect(decide.mock.calls[0]).toEqual(decide.mock.calls[1]);
});
