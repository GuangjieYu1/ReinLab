import {randomUUID} from 'node:crypto';
import type {Hono} from 'hono';
import {GateTransition} from '@reinlab/contracts';
import type {Database} from '../db/database';
import {transitionGate} from '../gates';
import {requireDossier} from '../ledger';
import {mutate,type ApiEnv} from './context';
import {denied} from './errors';

export function registerGates(app:Hono<ApiEnv>,database:Database) {
  app.post('/v1/dossiers/:id/gates/:subject/transition',c=>mutate(c,database,GateTransition,async(client,input)=>{
    const dossierId=c.req.param('id'),subject=c.req.param('subject');await requireDossier(client,dossierId);
    const result=await client.query('select id from gate where dossier_id=$1 and subject=$2',[dossierId,subject]);
    if(!result.rowCount)throw denied();
    const target={start:'running',discuss:'discuss',approve:'approved'} as const;
    const receipt=await transitionGate(client,c.get('accountId'),{gateId:result.rows[0].id,expectedState:input.expectedState,expectedRevision:input.expectedRevision,targetState:target[input.action],actor:'user',operationId:randomUUID()});
    return{status:200,body:receipt};
  }));
}
