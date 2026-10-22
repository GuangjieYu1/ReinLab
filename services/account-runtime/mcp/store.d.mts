export function bootstrapMcp(root:string,body:Record<string,unknown>,controlUrl:string):Promise<{installed:boolean}>;
export function removeMcp(root:string,runId:string):Promise<{removed:boolean}>;
export function cleanupMcp(root:string):Promise<void>;
export function accountFiles(root:string,body:Record<string,unknown>):Promise<Record<string,unknown>>;
