import pg from "pg";
import { randomUUID,createHash } from "node:crypto";
import { resolve } from "node:path";
import { Database } from "../src/db/database";
import { applyMigrations } from "../src/db/migrate";
import { loadBenchBundle, loadToolRegistry } from "../src/harness/manifest";
import { publishBench } from "../src/harness/store";
import { initialEffective } from "../src/harness/resolver";
import { bindRunCapabilities } from "../src/mcp/authority";
import { loadCapabilityCatalog, type CapabilityCatalog } from "../src/mcp/registry";
import { hash } from "../src/mcp/token";
export async function mcpFixture(catalogOverride?: CapabilityCatalog, declaredCard=false,version="1.0.0") {
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/reinlab_test", connectionTimeoutMillis:3000 });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL_APP ?? "postgres://reinlab_app@127.0.0.1:55432/reinlab_test", connectionTimeoutMillis:3000 });
  const db = new Database(pool), account = randomUUID(), dossier = randomUUID(), run = randomUUID(), hold = randomUUID();
  await applyMigrations(admin, resolve("infra/supabase/migrations"));
  const registry = await loadToolRegistry(), bundle = structuredClone(await loadBenchBundle({ benchId: "research", registry,version }));
  if(declaredCard){
    bundle.manifest.version="1.0.0-mcp-fixture-"+randomUUID();
    const schema=JSON.stringify({type:"object",properties:{kind:{const:"finding"},claim:{type:"string",minLength:1}},required:["kind","claim"],additionalProperties:false});
    bundle.manifest.cards.finding={schema:"schemas/research/finding.json",ui:"FindingCard",tool:"finding_record"};
    bundle.schemas={"schemas/research/finding.json":schema};
    bundle.referencedHashes["schemas/research/finding.json"]=createHash("sha256").update(schema).digest("hex");
    bundle.digest=hash({manifest:bundle.manifest,referencedHashes:bundle.referencedHashes,registryHash:bundle.registryHash});
  }
  await publishBench(admin, bundle, registry);
  const effective = initialEffective(bundle), catalog = catalogOverride ?? await loadCapabilityCatalog();
  await admin.query("insert into account(id) values($1)", [account]);
  await admin.query("insert into dossier(id,account_id,bench,title,workspace_path) values($1,$2,'research','mcp fixture',$3)", [dossier, account, "/data/dossiers/"+dossier]);
  await admin.query("insert into bench_effective(account_id,digest,bench,version,bundle_digest,snapshot) values($1,$2,$3,$4,$5,$6)", [account,effective.digest,"research",bundle.manifest.version,effective.bundleDigest,effective]);
  await admin.query("insert into run(id,account_id,dossier_id,role_id,mode,request_id,state,budget_cny) values($1,$2,$3,'research-read','read',$4,'running',1)", [run,account,dossier,randomUUID()]);
  await admin.query("insert into run_harness(account_id,dossier_id,run_id,bench,version,effective_digest,model_route) values($1,$2,$3,'research',$5,$4,'fixture/model')", [account,dossier,run,effective.digest,bundle.manifest.version]);
  await db.withAccount(account,c => bindRunCapabilities(c,account,run,effective,"research-read",{},catalog));
  const root=randomUUID(),allocation=randomUUID();
  await admin.query("insert into budget_allocation(id,account_id,dossier_id,period,amount_cny) values($1,$2,$3,date_trunc('month',now()),1)", [root,account,dossier]);
  await admin.query("insert into budget_allocation(id,account_id,dossier_id,run_id,parent_id,period,amount_cny,quota_limit,gpu_limit) values($1,$2,$3,$4,$5,date_trunc('month',now()),1,0,0)",[allocation,account,dossier,run,root]);
  await admin.query("insert into budget_hold(id,account_id,dossier_id,run_id,allocation_id,period,request_id,maximum_cny,maximum_quota,maximum_gpu_seconds,state) values($1,$2,$3,$4,$5,date_trunc('month',now()),$6,1,0,0,'reserved')", [hold,account,dossier,run,allocation,randomUUID()]);
  return { admin,pool,db,account,dossier,run,hold,catalog,effective, close: async()=>{await pool.end();await admin.end();} };
}
export async function implementedCatalog() {
  const catalog = structuredClone(await loadCapabilityCatalog());
  for (const cap of Object.values(catalog.capabilities)) cap.availability="implemented";
  catalog.digest=hash({revision:catalog.revision,capabilities:catalog.capabilities,aliases:catalog.aliases});
  return catalog;
}
