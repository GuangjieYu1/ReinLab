import type {Hono} from 'hono';
import {randomUUID} from 'node:crypto';
import {EstimateRequest,RunCreate,BudgetAppend,BudgetEstimate,QueuedRun,RunBudgetState} from '@reinlab/contracts';
import type {Database} from '../db/database';
import {PricingService} from '../budget/pricing';
import {allocateBudget,prepareDossierBudget,lockBudget,increaseRunBudget} from '../budget';
import {cny,micros} from '../budget/money';
import {requireDossier,appendEvent,scrub} from '../ledger';
import {mutate,type ApiEnv} from './context';
import {ApiFailure,denied} from './errors';

export function registerBudget(app:Hono<ApiEnv>,database:Database,pricing:PricingService) {
  app.post('/v1/runs/estimate',c=>mutate(c,database,EstimateRequest,async(client,input)=>{
    await requireDossier(client,input.dossierId);
    const quote=await pricing.estimate({mode:input.mode,modelTier:input.modelTier,size:input.size});
    const id=randomUUID(),result=await client.query("insert into budget_estimate(id,account_id,dossier_id,mode,model_tier,quote,expires_at) values($1,$2,$3,$4,$5,$6::jsonb,now()+interval '10 minutes') returning expires_at",[id,c.get('accountId'),input.dossierId,input.mode,quote.modelTier,JSON.stringify(quote)]);
    return{status:201,body:BudgetEstimate.parse({id,...quote,expiresAt:result.rows[0].expires_at.toISOString()})};
  }));
  app.post('/v1/runs',c=>mutate(c,database,RunCreate,async(client,input)=>{
    const accountId=c.get('accountId'),amount=cny(input.budget.cny);await lockBudget(client,accountId);await requireDossier(client,input.dossierId);
    const found=await client.query('select *,expires_at>now() valid from budget_estimate where id=$1',[input.estimateId]);if(!found.rowCount)throw denied();const estimate=found.rows[0];
    const role=await client.query('select model_tier from role_def where id=$1',[input.roleId]);
    if(!role.rowCount)throw new ApiFailure('SCOPE_DENIED',403,'该角色不可用于研究运行。');
    const expectedRole=input.mode==='read'?'research-read':input.mode==='auto'?'research-auto':'swarm-lead';
    if(!estimate.valid||estimate.dossier_id!==input.dossierId||estimate.mode!==input.mode||estimate.model_tier!==role.rows[0].model_tier||input.roleId!==expectedRole)throw new ApiFailure('ESTIMATE_MISMATCH',409,'估算已过期，或档案、模式和角色模型档不一致。');
    if((await client.query('select id from run where estimate_id=$1',[input.estimateId])).rowCount)throw new ApiFailure('ESTIMATE_CONSUMED',409,'该估算已经用于一个运行，请重新预估。');
    const quota=input.budget.quotaRuns??0,gpu=(input.budget.gpuMinutes??0)*60;if(!Number.isSafeInteger(gpu)||gpu>2147483647||quota>2147483647)throw new ApiFailure('INVALID_INPUT',400,'GPU预算必须能换算为整数秒，额度不得溢出。');
    if(micros(amount)<=0n)throw new ApiFailure('INVALID_INPUT',400,'运行预算必须大于零。');
    const root=await prepareDossierBudget(client,accountId,input.dossierId,amount),id=randomUUID(),requestId=randomUUID();
    await client.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny,quota_limit,gpu_limit,estimate_id,input) values($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11::jsonb)",[id,accountId,input.dossierId,input.roleId,input.mode,requestId,amount,quota,gpu,input.estimateId,JSON.stringify(scrub(input.input))]);
    await allocateBudget(client,accountId,{dossierId:input.dossierId,runId:id,parentId:root.id,amountCny:amount});
    await appendEvent(client,accountId,{dossierId:input.dossierId,runId:id,kind:'gate',action:'run_queued',risk:'write',payload:{estimateId:input.estimateId,model:estimate.quote.model,budgetCny:amount,quotaRuns:quota,gpuSeconds:gpu,confirmed:true},dedupeKey:'run-queued:'+id});
    return{status:201,body:QueuedRun.parse({id,dossierId:input.dossierId,mode:input.mode,state:'queued',budgetCny:amount,spentCny:'0.000000',quotaRuns:0,gpuSeconds:0})};
  }));
  app.post('/v1/runs/:id/budget',c=>mutate(c,database,BudgetAppend,async(client,input)=>({status:200,body:RunBudgetState.parse(await increaseRunBudget(client,c.get('accountId'),c.req.param('id'),input))})));
}
