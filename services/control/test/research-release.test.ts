import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import Ajv from 'ajv';
import {loadBenchBundle,loadToolRegistry} from '../src/harness/manifest';
it('research@1.1.0 only adds reviewed cards; archived1.0.0 bytes and registry remain unchanged',async()=>{
 const registry=await loadToolRegistry(),old=await loadBenchBundle({benchId:'research',version:'1.0.0',registry}),current=await loadBenchBundle({benchId:'research',registry});
 expect(current.manifest.version).toBe('1.1.0');expect(old.manifest.version).toBe('1.0.0');
 expect({...current.manifest,version:old.manifest.version,cards:old.manifest.cards}).toEqual(old.manifest);
 expect(Object.keys(current.manifest.cards).sort()).toEqual(['answer','finding','layer','quiz']);
 expect(current.registryHash).toBe(old.registryHash);
 expect(createHash('sha256').update(await readFile('benches/releases/research@1.0.0.bench.yaml')).digest('hex')).toBe(old.referencedHashes['benches/research.bench.yaml']);
});
it('reviewed card JSON schemas enforce frontend field shapes and bounded anchors',async()=>{
 const bundle=await loadBenchBundle({benchId:'research',registry:await loadToolRegistry()}),ajv=new Ajv({strict:true});
 ajv.addFormat('uuid',/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i);
 const anchor={paperId:'12345678-1234-4234-8234-123456789abc',page:1,quote:'原始证据'},cards={
  layer:{paperId:anchor.paperId,no:'01',title:'一句话',en:'ONE LINE',body:[{text:'解释',refs:[anchor]}]},
  quiz:{paperId:anchor.paperId,layer:'l1',q:'为何',keys:[['并行']],hint:'提示'},
  finding:{text:'发现',evidence:[anchor],confidence:'mid',status:'hypothesis'},
  answer:{questionRef:'question-1',text:'回答',citations:[anchor]},
 };
 for(const [name,card]of Object.entries(cards)){
  const declaration=bundle.manifest.cards[name];expect(declaration).toBeDefined();
  const validate=ajv.compile(JSON.parse(bundle.schemas![declaration.schema]));
  expect(validate(card)).toBe(true);expect(validate({...card,extra:'no'})).toBe(false);expect(validate({})).toBe(false);
 }
 const finding=ajv.compile(JSON.parse(bundle.schemas![bundle.manifest.cards.finding.schema]));
 expect(finding({...cards.finding,evidence:[]})).toBe(false);
 expect(finding({...cards.finding,evidence:[{...anchor,quote:'字'.repeat(301)}]})).toBe(false);
 expect(finding({...cards.finding,n:1,at:'client clock'})).toBe(false);
});

import {generateKeyPairSync} from 'node:crypto';
import {CapabilityAuthority} from '../src/mcp/authority';
import {CapabilitySigner} from '../src/mcp/token';
import {CapabilityEngine} from '../src/mcp/engine';
import {mcpFixture,implementedCatalog} from './mcp-fixture';
it('MCP tool discovery exposes the frozen card shape; pinned1.0.0 advertises no undeclared card',async()=>{
 for(const version of ['1.0.0','1.1.0']){
  const f=await mcpFixture(await implementedCatalog(),false,version);
  try{
   const authority=new CapabilityAuthority(f.db,new CapabilitySigner(generateKeyPairSync('ed25519').privateKey)),auth=await authority.validate(await authority.issue(f.account,f.run)),engine=new CapabilityEngine(authority,{});
   const schema=await engine.inputSchema(auth,'cards.card.quiz');
   if(version==='1.0.0')expect(schema).toBeNull();
   else {expect((schema!.properties as any).card.required).toContain('keys');expect((schema!.properties as any).card.properties.q.type).toBe('string');}
  }finally{await f.close();}
 }
});
