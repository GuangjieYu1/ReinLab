import { it,expect } from "vitest";
import { mkdtemp,mkdir,writeFile,readFile,symlink,link,rm,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { accountFiles } from "../src/mcp/files";
it("T-MCP-4 descriptor-relative paths reject traversal, links and special files; atomic patch and undo restore versions",async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"reinlab-mcp-files-"))),dossier=randomUUID();
 const dir=path.join(root,"dossiers",dossier),targets=["findings/"];
 await mkdir(path.join(dir,"findings"),{recursive:true});await writeFile(path.join(dir,"findings/a.md"),"old");
 const call=(operation:string,args:Record<string,unknown>,fault?:"before_commit")=>accountFiles(root,dossier,operation,args,targets,fault);
 try{
  for(const p of ["../escape","/etc/passwd","findings/../escape","results/a.md","findings/AGENTS.md"])
   await expect(call("write",{path:p,content:"bad"})).rejects.toMatchObject({code:"FILE_SCOPE_DENIED"});
  const old=await call("patch",{changes:[{path:"findings/a.md",content:"new"},{path:"findings/b.md",content:"second"}]});
  expect(await readFile(path.join(dir,"findings/a.md"),"utf8")).toBe("new");
  await call("undo",{versionId:old.versionId});
  expect(await readFile(path.join(dir,"findings/a.md"),"utf8")).toBe("old");
  await expect(readFile(path.join(dir,"findings/b.md"))).rejects.toMatchObject({code:"ENOENT"});
  await expect(call("patch",{changes:[{path:"findings/a.md",content:"partial"},{path:"results/no.md",content:"bad"}]})).rejects.toMatchObject({code:"FILE_SCOPE_DENIED"});
  await expect(call("patch",{changes:[{path:"findings/a.md",content:"partial"},{path:"findings/b.md",content:"bad"}]},"before_commit")).rejects.toThrow();
  expect(await readFile(path.join(dir,"findings/a.md"),"utf8")).toBe("old");
  await symlink("/etc",path.join(dir,"findings/link"));
  await expect(call("read",{path:"findings/link/passwd"})).rejects.toMatchObject({code:"FILE_SCOPE_DENIED"});
  await rm(path.join(dir,"findings/link"));
  await link(path.join(dir,"findings/a.md"),path.join(dir,"findings/hard"));
  await expect(call("read",{path:"findings/hard"})).rejects.toMatchObject({code:"FILE_SCOPE_DENIED"});
  await rm(path.join(dir,"findings/hard"));
  execFileSync("mkfifo",[path.join(dir,"findings/fifo")]);
  await expect(call("read",{path:"findings/fifo"})).rejects.toMatchObject({code:"FILE_SCOPE_DENIED"});
  await rm(path.join(dir,"findings/fifo"));
  await expect(call("write",{path:"findings/huge",content:"a".repeat(1024*1024+1)})).rejects.toMatchObject({code:"FILE_TOO_LARGE"});
 }finally{await rm(root,{recursive:true,force:true});}
});
