import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants, openSync, type Stats } from "node:fs";
import { open, mkdir, lstat, rename, unlink } from "node:fs/promises";
import { dirname, basename, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { getuid } from "node:process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

/** 控制面日志文件句柄：与会话记录同目录，追加写入。 */
let controlLogFd: number | undefined;
function logFd(): number {
  if (controlLogFd === undefined) {
    const dir = process.env.REINLAB_CONTROL_LOG_DIR;
    const file = (dir ? dir + "/" : "") + "control.log";
    controlLogFd = openSync(file, "a", 0o600);
  }
  return controlLogFd;
}

export type ControlRecord = {
  pid: number;
  instance: string;
  executable: string;
  script: string;
  legacy?: true;
};
const unsafe = () => Error("LOCAL_CONTROL_RECORD_UNSAFE");
function privateFile(stat: Stats) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.uid !== getuid?.() ||
    stat.size > 8192
  )
    throw unsafe();
}
function validRecord(value: unknown): value is ControlRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as ControlRecord;
  return (
    Object.keys(record).every((key) =>
      ["pid", "instance", "executable", "script"].includes(key),
    ) &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 1 &&
    /^[a-f0-9-]{36}$/.test(record.instance) &&
    typeof record.executable === "string" &&
    isAbsolute(record.executable) &&
    typeof record.script === "string" &&
    isAbsolute(record.script) &&
    !/[\r\n\0]/.test(record.executable + record.script)
  );
}
export async function readControlRecord(
  file: string,
): Promise<ControlRecord | undefined> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    privateFile(await handle.stat());
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (validRecord(value)) return value;
    // Upgrade only the previous private format. Its nonce must still match the
    // exact live Node command/group before it authorizes any signal.
    const legacy = value as {
      pid?: unknown;
      instance?: unknown;
      startedAt?: unknown;
    };
    if (
      legacy &&
      typeof legacy === "object" &&
      Object.keys(legacy).every((key) =>
        ["pid", "instance", "startedAt"].includes(key),
      ) &&
      Number.isSafeInteger(legacy.pid) &&
      Number(legacy.pid) > 1 &&
      typeof legacy.instance === "string" &&
      /^[a-f0-9-]{36}$/.test(legacy.instance) &&
      typeof legacy.startedAt === "string" &&
      !Number.isNaN(Date.parse(legacy.startedAt))
    ) {
      return {
        pid: Number(legacy.pid),
        instance: legacy.instance,
        executable: "",
        script: "",
        legacy: true,
      };
    }
    throw unsafe();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw unsafe();
  } finally {
    await handle?.close();
  }
}
export async function writeControlRecord(file: string, record: ControlRecord) {
  if (!validRecord(record)) throw unsafe();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const parent = await lstat(dirname(file));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== getuid?.() ||
    (parent.mode & 0o777) !== 0o700
  )
    throw unsafe();
  // Refuse an existing link/unsafe inode before staging or replacing anything.
  await readControlRecord(file);
  const temporary = file + "." + randomUUID() + ".tmp";
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(JSON.stringify(record) + "\n");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await readControlRecord(file);
    await rename(temporary, file);
  } catch {
    throw unsafe();
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

/** Only the IPC channel belonging to our ChildProcess can establish readiness. */
export function waitForControlReady(
  child: ChildProcess,
  instance: string,
  port = 3001,
  timeoutMs = 30000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off("message", message);
      child.off("error", failed);
      child.off("exit", failed);
      if (error) reject(error);
      else resolve();
    };
    const failed = () => finish(Error("LOCAL_CONTROL_UNAVAILABLE"));
    const message = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const ready = value as Record<string, unknown>;
      if (
        ready.type === "reinlab.control.ready" &&
        ready.pid === child.pid &&
        ready.instance === instance &&
        ready.port === port
      )
        finish();
    };
    const timer = setTimeout(failed, timeoutMs);
    child.on("message", message);
    child.once("error", failed);
    child.once("exit", failed);
    if (child.exitCode !== null || child.signalCode !== null) failed();
  });
}

async function terminateHeldChild(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = (timeoutMs: number) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        child.off("close", finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      child.once("close", finish);
      if (child.exitCode !== null || child.signalCode !== null) finish();
    });
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, value);
    } catch {
      /* Our child already exited. */
    }
  };
  signal("SIGTERM");
  await exited(3000);
  if (child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    await exited(1000);
  }
}

export async function startControlProcess(options: {
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  recordFile: string;
  timeoutMs?: number;
  port?: number;
  /** Pinned Node runtime; never the Electron/parent executable. */
  node?: string;
}) {
  const instance = randomUUID();
  const executable = options.node ?? process.execPath;
  if (
    process.env.REINLAB_LOCAL_STACK === "1" &&
    process.versions.electron &&
    !options.node
  )
    throw Error("LOCAL_ELECTRON_RUNTIME_FORBIDDEN");
  const child = spawn(
    executable,
    ["--import", "tsx", options.script, "--instance", instance],
    {
      cwd: options.cwd,
      env: options.env,
      // 控制面的 stderr 落盘：出问题要能看见真实原因，而不是只剩一句
      //「本地环境尚未就绪」。日志与运行记录同目录，权限跟着状态目录走。
      stdio: [
        "ignore",
        "ignore",
        logFd(),
        "ipc",
      ],
      detached: true,
    },
  );
  // Keep an error listener even after the startup waiter removes its own one.
  child.on("error", () => {});
  try {
    await waitForControlReady(
      child,
      instance,
      options.port ?? 3001,
      options.timeoutMs,
    );
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw Error("LOCAL_CONTROL_UNAVAILABLE");
    const record: ControlRecord = {
      pid: child.pid,
      instance,
      executable,
      script: options.script,
    };
    await writeControlRecord(options.recordFile, record);
    if (child.exitCode !== null || child.signalCode !== null)
      throw Error("LOCAL_CONTROL_UNAVAILABLE");
    if (child.connected) child.disconnect();
    child.unref();
    return { ...record, stop: () => terminateHeldChild(child) };
  } catch (error) {
    await terminateHeldChild(child);
    throw error;
  }
}

type Identity = { group: number; command: string };
type StopOptions = {
  inspect?: (pid: number) => Promise<Identity | undefined>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  graceMs?: number;
};
async function inspectProcess(pid: number): Promise<Identity | undefined> {
  try {
    const { stdout } = await promisify(execFile)(
      "ps",
      ["-ww", "-p", String(pid), "-o", "pgid=", "-o", "command="],
      { timeout: 3000, maxBuffer: 16384 },
    );
    const match = /^\s*(\d+)\s+([^\r\n]+)\s*$/.exec(stdout);
    return match
      ? { group: Number(match[1]), command: match[2].trim() }
      : undefined;
  } catch {
    return;
  }
}
export async function stopOwnedControl(
  file: string,
  script: string,
  options: StopOptions = {},
) {
  const record = await readControlRecord(file);
  if (!record || (!record.legacy && record.script !== script)) return;
  const inspect = options.inspect ?? inspectProcess;
  const signal = options.signal ?? ((pid, value) => process.kill(-pid, value));
  const suffix = ` --import tsx ${script} --instance ${record.instance}`;
  const owned = async () => {
    const current = await inspect(record.pid);
    if (
      !current ||
      current.group !== record.pid ||
      !current.command.endsWith(suffix)
    )
      return false;
    const executable = current.command.slice(0, -suffix.length);
    return record.legacy
      ? isAbsolute(executable) && basename(executable) === "node"
      : executable === record.executable;
  };
  if (!(await owned())) return;
  try {
    signal(record.pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + (options.graceMs ?? 15000);
  while (Date.now() < deadline) {
    if (!(await owned())) return;
    await delay(50);
  }
  // PID/group reuse must never inherit a previous record's authority.
  if (!(await owned())) return;
  try {
    signal(record.pid, "SIGKILL");
  } catch {
    return;
  }
  const killedDeadline = Date.now() + 2000;
  while (Date.now() < killedDeadline) {
    if (!(await owned())) return;
    await delay(50);
  }
  throw Error("LOCAL_CONTROL_STOP_FAILED");
}
