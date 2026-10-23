import {it,expect} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {CapabilityAuthority} from '../src/mcp/authority';
import {CapabilitySigner} from '../src/mcp/token';
import {CapabilityEngine} from '../src/mcp/engine';
import {dataHandlers} from '../src/mcp/data-handlers';
import {implementedCatalog,mcpFixture} from './mcp-fixture';
async function fixture(){
 const f=await mcpFixture(await implementedCatalog(),false,'1.1.0'),asset=randomUUID();
 await f.admin.query("insert into paper_asset(id,account_id,dossier_id,run_id,paper_id,source,license,status,is_open_access,sha256,path,abstract) values($1,$2,$3,$4,'W1','https://api.openalex.org/works/W1','cc-by','full_text',true,$5,'papers/fixture.pdf','')",[asset,f.account,f.dossier,f.run,'a'.repeat(64)]);
 const authority=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync('ed25519').privateKey)),token=await authority.issue(f.account,f.run),context=await authority.validate(token),deposits:any[]=[];
 const handlers=dataHandlers(f.db,async(...args:any[])=>{deposits.push(args);});
 const engine=new CapabilityEngine(authority,{'papers.pages':async()=>({assetId:asset,status:'full_text',pages:[{page:1,anchor:'paper:'+asset+'#page=1',text:'已读取的原始证据。'}]})});
 const read=()=>engine.call('papers',token,{capability:'papers.pages',args:{assetId:asset,pages:[1]}});
 return {...f,asset,context,handlers,deposits,read};
}
it('cards reject unread, foreign and invented citations; successful papers.pages receipt is required',async()=>{
 const f=await fixture();try{
 const valid={text:'发现',evidence:[{paperId:f.asset,page:1,quote:'原始证据'}],confidence:'mid',status:'supported'};
 const call=(card:any)=>f.handlers['cards.card.finding'](f.context,{card},randomUUID());
 await expect(call(valid)).rejects.toMatchObject({code:'CARD_CITATION_UNVERIFIED'});
 await f.read();
 for(const evidence of [[{...valid.evidence[0],page:2}],[{...valid.evidence[0],paperId:randomUUID()}],[{...valid.evidence[0],quote:'编造原文'}]]) await expect(call({...valid,evidence})).rejects.toMatchObject({code:'CARD_CITATION_UNVERIFIED'});
 const result=await call(valid);const rows=(await f.admin.query("select payload from event where run_id=$1 and action='card_created'",[f.run])).rows;
 expect(rows).toHaveLength(1);expect(rows[0].payload.card).toMatchObject({...valid,n:1,at:expect.any(String)});expect(result).toEqual({cardId:rows[0].payload.cardId});
 }finally{await f.close();}
});
it('quiz keys go only to dossier deposit, never event or result; no deposit fails closed',async()=>{
 const f=await fixture();try{
 await f.read();const card={paperId:f.asset,layer:'l1',q:'为何',keys:[['只存在档案的答案']],hint:'提示'};
 const result=await f.handlers['cards.card.quiz'](f.context,{card},randomUUID());
 expect(f.deposits).toHaveLength(1);expect(f.deposits[0][3]).toEqual(card);
 const rows=(await f.admin.query("select payload from event where run_id=$1 and action='card_created'",[f.run])).rows;
 expect(JSON.stringify({result,rows})).not.toContain('只存在档案的答案');expect(rows[0].payload.card).not.toHaveProperty('keys');
 await expect(dataHandlers(f.db)['cards.card.quiz'](f.context,{card},randomUUID())).rejects.toMatchObject({code:'CARD_STORAGE_UNAVAILABLE'});
 }finally{await f.close();}
});
