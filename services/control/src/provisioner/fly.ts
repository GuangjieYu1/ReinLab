import {z} from 'zod';
import {ApiFailure} from '../api/errors';
const machine=z.object({id:z.string().regex(/^[a-f0-9]{10,32}$/),name:z.string(),state:z.string(),region:z.string(),config:z.object({metadata:z.record(z.string()).optional(),mounts:z.array(z.object({volume:z.string(),path:z.string()})).optional(),image:z.string().optional()}).passthrough()}).passthrough();
const volume=z.object({id:z.string().regex(/^vol_[a-zA-Z0-9]+$/),name:z.string(),region:z.string(),attached_machine_id:z.string().nullable().optional()}).passthrough();
export type FlyMachine=z.infer<typeof machine>;
export type FlyVolume=z.infer<typeof volume>;
export type {Machines} from './driver';
import type {Machines} from './driver';
export class FlyMachines implements Machines {
  constructor(readonly app:string,private token:string,private transport:typeof fetch=fetch){if(!/^[a-z0-9][a-z0-9-]{1,62}$/.test(app)||!token)throw new Error('FLY_CONFIG_REQUIRED');}
  private async call(path:string,method='GET',body?:unknown):Promise<unknown>{
    try {const r=await this.transport('https://api.machines.dev/v1/apps/'+this.app+path,{method,redirect:'error',headers:{authorization:'Bearer '+this.token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('FLY_RESPONSE');const raw=await r.text();if(raw.length>4*1024*1024)throw new Error('FLY_RESPONSE');return raw?JSON.parse(raw):{};}catch{throw new ApiFailure('PROVISIONER_UNAVAILABLE',503,'账户机器服务暂时不可用，请稍后重试。');}
  }
  async listMachines(){return z.array(machine).parse(await this.call('/machines'));}
  async listVolumes(){return z.array(volume).parse(await this.call('/volumes'));}
  async createVolume(name:string){return volume.parse(await this.call('/volumes','POST',{name,region:'nrt',size_gb:3,encrypted:true,machines_only:true,snapshot_retention:7,auto_backup_enabled:true}));}
  async createMachine(plan:unknown){return machine.parse(await this.call('/machines','POST',plan));}
  async start(id:string){if(!/^[a-f0-9]{10,32}$/.test(id))throw new Error('MACHINE_ID_INVALID');await this.call('/machines/'+id+'/start','POST');}
  async update(id:string,config:unknown){if(!/^[a-f0-9]{10,32}$/.test(id))throw new Error('MACHINE_ID_INVALID');await this.call('/machines/'+id,'POST',{config});}
}
