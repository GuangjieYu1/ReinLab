/** Actual deployment values are read privately and compared in memory. Counts only. */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readRuntimeConfiguration } from "../src/configuration";
import { readAccountCredentials } from "../../account-runtime/credentials.mjs";
import { environmentDriver } from "../src/provisioner";
import { readControlRecord } from "../../../tooling/local/control-process";
import { localPaths } from "../../../tooling/local/paths";
const paths = localPaths(),
  config = readRuntimeConfiguration(paths.runtime);
process.env.REINLAB_RUNTIME_CONFIG_FILE = paths.runtime;
let phase = "list";
const results: {
  scope: string;
  passed: boolean;
  processes?: number;
  blocked?: number;
}[] = [];
function capture(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let data = "",
      overflow = false;
    const timer = setTimeout(() => p.kill(), 15000);
    for (const s of [p.stdout, p.stderr])
      s.on("data", (b) => {
        if (data.length + b.length > 2 * 1024 * 1024) {
          overflow = true;
          p.kill();
        } else data += b.toString();
      });
    p.on("error", () => reject(Error("AUDIT_COMMAND_FAILED")));
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 && !overflow
        ? resolve(data)
        : reject(Error("AUDIT_COMMAND_FAILED"));
    });
  });
}
try {
  const env = { PATH: process.env.PATH, DOCKER_HOST: config.DOCKER_HOST },
    machines = await environmentDriver().listMachines();
  if (machines.length !== 4 || !config.REINLAB_DOCKER_CREDENTIAL_DIR)
    throw Error("AUDIT_ACCOUNT_SET_CHANGED");
  for (const m of machines) {
    phase = "read_file";
    const id = m.config.metadata!.reinlab_account_id,
      credentials = readAccountCredentials(
        join(config.REINLAB_DOCKER_CREDENTIAL_DIR, id, "account.json"),
        { accountId: id },
      );
    phase = "account_processes";
    const result = JSON.parse(
      await capture(
        "docker",
        [
          "exec",
          "--user",
          "1000",
          m.id,
          "node",
          "--input-type=module",
          "-e",
          `import{readFileSync,readdirSync}from'node:fs';import{readAccountCredentials}from'/services/account-runtime/credentials.mjs';const c=readAccountCredentials('/run/reinlab-private/account.json',{accountId:process.env.REINLAB_ACCOUNT_ID,owner:1000,parentOwner:1000});let processes=0,matches=0,blocked=0;for(const pid of readdirSync('/proc').filter(v=>/^\\d+$/.test(v))){try{const b=readFileSync('/proc/'+pid+'/environ','utf8');processes++;matches+=Number(b.includes(c.auth)||b.includes(c.container));}catch(e){if(e.code==='EACCES')blocked++;else if(e.code!=='ENOENT')process.exit(1);}}console.log(JSON.stringify({processes,matches,blocked}));`,
        ],
        env,
      ),
    );
    if (result.matches !== 0 || result.processes < 1)
      throw Error("AUDIT_MATCH");
    results.push({
      scope: "account_readable_process_environments",
      passed: true,
      processes: result.processes,
      blocked: result.blocked,
    });
    phase = "account_logs";
    const logs = await capture("docker", ["logs", m.id], env);
    if (logs.includes(credentials.auth) || logs.includes(credentials.container))
      throw Error("AUDIT_MATCH");
    results.push({ scope: "account_stdout_stderr", passed: true });
  }
  phase = "control_process";
  const record = await readControlRecord(paths.process);
  if (!record) throw Error("AUDIT_CONTROL_MISSING");
  const observed = await capture(
    "/bin/ps",
    ["eww", "-p", String(record.pid), "-o", "command="],
    { PATH: process.env.PATH },
  );
  const secrets = Object.entries(config)
    .filter(
      ([key, value]) =>
        value &&
        /(?:_KEY|_TOKEN|_SECRET|_PASSWORD)$|^DATABASE_URL(?:_|$)/.test(key),
    )
    .map(([, value]) => value!);
  if (secrets.some((v) => observed.includes(v))) throw Error("AUDIT_MATCH");
  results.push({ scope: "control_process_environment", passed: true });
} catch {
  results.push({ scope: "runtime_credential_audit:" + phase, passed: false });
  process.exitCode = 1;
}
const out =
  process.env.REINLAB_EVIDENCE_OUT ?? "/tmp/reinlab-p112-runtime-audit";
await mkdir(out, { recursive: true });
const report = {
  realInfrastructure: true,
  modelRequests: 0,
  passed: results.filter((v) => v.passed).length,
  failed: results.filter((v) => !v.passed).length,
  results,
};
await writeFile(
  join(out, "runtime-credential-audit.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
