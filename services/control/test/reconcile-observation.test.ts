import { expect, it, vi } from 'vitest';
import { reconcileObservation } from '../src/bridge/openscience/reconcile';
const current = (latestSequence=2) => ({sessionID:'session',latestSequence,runs:[],permissions:[],questions:[]});
function fixture() {
 let cursor=0;const snapshot=vi.fn(async()=>current()),replay=vi.fn(async()=>({events:[{sequence:1},{sequence:2},{sequence:3}]}));
 const sink={cursor:async()=>cursor,ingest:vi.fn(async(raw:any)=>{cursor=raw.sequence;}),synchronize:vi.fn(),gap:vi.fn(),failed:vi.fn()};
 return {reader:{snapshot,replay},sink,get cursor(){return cursor;}};
}
it('P1-13 finite observation commits only a fixed high-water and exposes no submit/subscribe capability',async()=>{
 const f=fixture();const r=await reconcileObservation({reader:f.reader,sink:f.sink,sessionID:'session'} as any);
 expect(f.cursor).toBe(2);expect(r).toEqual({cursor:2,highWater:2,caughtUp:true});expect(f.sink.ingest).toHaveBeenCalledTimes(2);expect(f.sink.synchronize).toHaveBeenCalledOnce();
});
it('P1-13 bounds each pass while retaining the cursor so a later pass continues, never silently skipping history',async()=>{
 const f=fixture();f.reader.snapshot.mockImplementation(async()=>current(1200));f.reader.replay.mockImplementation(async()=>({events:Array.from({length:1200},(_,i)=>({sequence:i+1}))}));
 const r=await reconcileObservation({reader:f.reader,sink:f.sink,sessionID:'session'} as any);expect(r).toEqual({cursor:1000,highWater:1200,caughtUp:false});expect(f.sink.synchronize).not.toHaveBeenCalled();
});
it('P1-13 rejects foreign snapshots and cursor regression before any ingest',async()=>{
 const f=fixture();f.reader.snapshot.mockImplementation(async()=>({...current(),sessionID:'foreign'}));await expect(reconcileObservation({reader:f.reader,sink:f.sink,sessionID:'session'} as any)).rejects.toThrow();expect(f.sink.ingest).not.toHaveBeenCalled();
});
