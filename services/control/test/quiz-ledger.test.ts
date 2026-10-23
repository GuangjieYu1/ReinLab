import {it,expect} from 'vitest';
import {mapRuntimeEvent} from '../src/bridge/openscience/mapping';
it.each(['read_quiz_write','cards_card_quiz'])('quiz工具%s输入raw/metadata/输出均不把keys复制到公开账本',(tool)=>{
 const secret='QUIZ_PRIVATE_SOLUTION';
 const result=mapRuntimeEvent({sequence:1,sessionID:'s',runID:'r',type:'message.part.updated',time:1,properties:{part:{id:'p',sessionID:'s',messageID:'m',type:'tool',tool,callID:'call',state:{status:'completed',input:{capability:'cards.card.quiz',args:{keys:[[secret]],paperId:'paper',layer:'one'}},raw:secret,metadata:{echo:secret},output:secret,title:'quiz',time:{start:1,end:2}}}}},{toolGrants:{[tool]:{permission:'ask',risk:'write'}}});
 expect(result.kind).toBe('tool');expect(JSON.stringify(result)).not.toContain(secret);expect(JSON.stringify(result)).not.toContain('keys');
});
