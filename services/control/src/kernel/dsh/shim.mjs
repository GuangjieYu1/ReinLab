// Run-scoped kernel shim. The official SDK client spawns this module as
// `node <shim> --profile sdk --patch ...`; it starts the real dsh runtime either
// on the host or inside the account container, records this run's pid, and on
// teardown confirms the runtime actually stopped instead of trusting the
// transport handle.
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";

const mode = process.env.SHIM_MODE ?? "host";
const pidFile = process.env.SHIM_PID_FILE ?? "";
const runId = process.env.SHIM_RUN_ID ?? "unknown";
const dshModule = process.env.SHIM_DSH_MODULE ?? "";
const container = process.env.SHIM_CONTAINER ?? "";
const hostRoot = process.env.SHIM_HOST_ROOT ?? "";
const containerRoot = process.env.SHIM_CONTAINER_ROOT ?? "/opt/reinlab";

if (!dshModule) {
  process.stderr.write(JSON.stringify({ shim: "missing-dsh-module", runId }) + "\n");
  process.exit(2);
}

// The runtime must be a real Node binary: dsh refuses to boot inside an
// Electron-embedded Node, and the caller that spawns this shim may be one.
const nodeBin = process.env.SHIM_NODE ?? process.execPath;
const args = process.argv.slice(2);
const command =
  mode === "docker"
    ? [
        "docker",
        ["exec", "-i", container, "node", dshModule, ...args.map((arg) => (hostRoot ? arg.split(hostRoot).join(containerRoot) : arg))],
      ]
    : [nodeBin, [dshModule, ...args]];

const child = spawn(command[0], command[1], { stdio: ["inherit", "inherit", "inherit"] });
if (pidFile) {
  try {
    writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  } catch {
    /* the control plane treats a missing pid as unconfirmed, never as stopped */
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const inContainerAlive = (pid) => {
  try {
    const probe = spawn("docker", ["exec", container, "kill", "-0", String(pid)], { stdio: "ignore" });
    probe.on("exit", (code) => {
      if (code !== 0) confirmedGone(pid);
    });
    return true;
  } catch {
    return false;
  }
};

let confirming = false;
function confirmedGone(pid) {
  if (pidFile) rmSync(pidFile, { force: true });
  process.stderr.write(JSON.stringify({ shim: "stopped-confirmed", runId, pid }) + "\n");
  process.exit(0);
}

async function stopAndConfirm() {
  if (confirming) return;
  confirming = true;
  const pid = child.pid;
  try {
    child.kill("SIGTERM");
  } catch {}
  const deadline = Date.now() + Number(process.env.SHIM_STOP_TIMEOUT_MS ?? 8000);
  for (;;) {
    const gone = mode === "docker" ? !inContainerAlive(pid) : !alive(pid);
    if (gone) return confirmedGone(pid);
    if (Date.now() >= deadline) {
      process.stderr.write(JSON.stringify({ shim: "stop-unconfirmed", runId, pid }) + "\n");
      process.exit(3);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

child.on("exit", (code) => {
  if (pidFile) rmSync(pidFile, { force: true });
  process.exit(code ?? 0);
});
process.on("SIGTERM", () => void stopAndConfirm());
process.on("SIGINT", () => void stopAndConfirm());
process.stdin.on("end", () => void stopAndConfirm());
