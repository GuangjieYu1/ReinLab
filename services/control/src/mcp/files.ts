import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ApiFailure } from "../api/errors";
import type { CapabilityHandler } from "./engine";
const helper=fileURLToPath(new URL("../../../account-runtime/mcp/files.py",import.meta.url));
/** This port runs only in an account process. Root is trusted deployment configuration. */
export async function accountFiles(root:string,dossier:string,operation:string,args:Record<string,unknown>,writeTargets:string[], fault?:"before_commit") {
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const child=spawn("python3",[helper],{env:{PATH:"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"},stdio:["pipe","pipe","pipe"]});
    const output:Buffer[]=[];let size=0,failed=false;
    const fail=()=>{failed=true;child.kill();reject(new ApiFailure("FILES_UNAVAILABLE",503,"档案文件服务不可用。"));};
    const timer=setTimeout(fail,30000);
    child.on("error",fail);
    child.stdout.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024)fail();else output.push(chunk);});
    child.stderr.resume();
    child.on("close",()=>{
      clearTimeout(timer);if(failed)return;
      try{
        const parsed=JSON.parse(Buffer.concat(output).toString("utf8"));
        if(parsed.error)throw new ApiFailure(["FILE_TOO_LARGE","DOSSIER_TOO_LARGE"].includes(parsed.error)?parsed.error:"FILE_SCOPE_DENIED",parsed.error.includes("TOO_LARGE")?413:403,"档案文件请求被拒绝。");
        if(!parsed.result||typeof parsed.result!=="object")throw new Error();
        resolve(parsed.result);
      }catch(error){reject(error instanceof ApiFailure?error:new ApiFailure("FILES_UNAVAILABLE",503,"档案文件服务不可用。"));}
    });
    child.stdin.on("error",()=>{});
    child.stdin.end(JSON.stringify({root,dossier,operation,args,writeTargets,...(fault?{fault}:{})}));
  });
}
export function fileHandlers(root:string):Record<string,CapabilityHandler>{
  return Object.fromEntries(["list","read","write","patch","undo"].map(operation=>["files."+operation,async(context,args)=>{
    const grant=context.scope.grants.find(g=>g.name==="files."+operation);
    if(!grant)throw new ApiFailure("CAPABILITY_DENIED",403,"档案文件能力未授权。");
    return accountFiles(root,context.claims.dossier,operation,args,grant.writeTargets);
  }]));
}
