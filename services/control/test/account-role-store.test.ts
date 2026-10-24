import { expect, it } from "vitest";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as roles from "../src/bridge/openscience/role-project";
const request = () => ({
  dossierId: randomUUID(),
  role: {
    id: "research-read",
    prompt: "使用中文。",
    toolGrants: {},
    writeTargets: [],
    steps: 2,
  },
  model: "deepseek/deepseek-v4-flash",
  memory: "过滤记忆",
});
it("account store returns only the expected managed receipt and refuses caller-selected roots/plugins", async () => {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), "reinlab-account-role-")),
    ),
    body = request();
  const fixed = {
    root,
    pluginUrl: "file:///opt/reinlab/plugin/index.js",
    accountId: randomUUID(),
  };
  try {
    const prepare = Reflect.get(roles, "prepareAccountRole");
    const receipt = await prepare(body, fixed),
      plan = roles.planRoleProject({
        ...body,
        root,
        pluginUrl: fixed.pluginUrl,
      });
    expect(receipt).toEqual({
      schemaVersion: 1,
      accountId: fixed.accountId,
      ...plan.project,
      hashes: plan.hashes,
      pluginUrl: fixed.pluginUrl,
    });
    expect(JSON.stringify(receipt)).not.toContain(body.memory);
    expect(await prepare(body, fixed)).toEqual(receipt);
    for (const extra of [
      { root: "/outside" },
      { pluginUrl: "file:///outside/plugin.js" },
    ])
      await expect(prepare({ ...body, ...extra }, fixed)).rejects.toMatchObject(
        { code: "SCOPE_DENIED" },
      );
    await expect(
      prepare({ ...body, memory: "changed without a new version" }, fixed),
    ).rejects.toMatchObject({ code: "SCOPE_DENIED" });
    expect(
      await readFile(join(plan.project.directory, "AGENTS.md"), "utf8"),
    ).toContain(body.memory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('recovery verification never materializes a missing project and refuses changed files', async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'reinlab-verify-role-'))), body=request();
 const fixed={root,pluginUrl:'file:///opt/reinlab/plugin/index.js',accountId:randomUUID()};
 try {
  await expect(roles.prepareAccountRole(body,fixed,true)).rejects.toMatchObject({code:'SCOPE_DENIED'});
  await expect(readFile(join(root,'roles',body.dossierId,body.role.id,'AGENTS.md'))).rejects.toMatchObject({code:'ENOENT'});
  const receipt=await roles.prepareAccountRole(body,fixed);
  expect(await roles.prepareAccountRole(body,fixed,true)).toEqual(receipt);
  await expect(roles.prepareAccountRole({...body,memory:'changed'},fixed,true)).rejects.toMatchObject({code:'SCOPE_DENIED'});
 } finally {await rm(root,{recursive:true,force:true});}
});
