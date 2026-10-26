import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  mkdtemp,
  writeFile,
  readFile,
  symlink,
  link,
  rm,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  readControlRecord,
  writeControlRecord,
  waitForControlReady,
  startControlProcess,
  stopOwnedControl,
} from "./control-process";
const roots: string[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function files() {
  const root = await mkdtemp(join(tmpdir(), "reinlab-control-process-"));
  roots.push(root);
  return { root, file: join(root, "control.json") };
}
const record = () => ({
  pid: 12345,
  instance: randomUUID(),
  executable: process.execPath,
  script: "/review/control.ts",
});
const child = () =>
  Object.assign(new EventEmitter(), {
    pid: 12345,
    exitCode: null,
    signalCode: null,
  }) as ChildProcess;
it("never accepts a foreign HTTP health response as this child becoming ready", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    waitForControlReady(child(), randomUUID(), 3001, 20),
  ).rejects.toThrow("LOCAL_CONTROL_UNAVAILABLE");
  expect(fetch).not.toHaveBeenCalled();
});
it("requires the exact child PID, launch nonce and bound port over IPC", async () => {
  const probe = child(),
    instance = randomUUID();
  const ready = waitForControlReady(probe, instance, 3001, 100);
  probe.emit("message", {
    type: "reinlab.control.ready",
    pid: probe.pid,
    instance,
    port: 3001,
  });
  await expect(ready).resolves.toBeUndefined();
});
it.each(["wrong-instance", "wrong-pid", "wrong-port"])(
  "rejects IPC with %s",
  async (which) => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const probe = child(),
      instance = randomUUID();
    const ready = waitForControlReady(probe, instance, 3001, 20);
    probe.emit("message", {
      type: "reinlab.control.ready",
      pid: which === "wrong-pid" ? 54321 : probe.pid,
      instance: which === "wrong-instance" ? randomUUID() : instance,
      port: which === "wrong-port" ? 9999 : 3001,
    });
    await expect(ready).rejects.toThrow("LOCAL_CONTROL_UNAVAILABLE");
  },
);
it("writes and reads a private ordinary process record", async () => {
  const { file } = await files(),
    value = record();
  await writeControlRecord(file, value);
  expect(await readControlRecord(file)).toEqual(value);
  expect((await lstat(file)).mode & 0o777).toBe(0o600);
});
it.each(["symlink", "hardlink", "broad-permissions"])(
  "refuses an unsafe %s record without modifying its target",
  async (kind) => {
    const { root, file } = await files(),
      target = join(root, "unrelated");
    await writeFile(target, "untouched", {
      mode: kind === "broad-permissions" ? 0o644 : 0o600,
    });
    if (kind === "symlink") await symlink(target, file);
    else if (kind === "hardlink") await link(target, file);
    else await writeFile(file, "untouched", { mode: 0o644 });
    await expect(writeControlRecord(file, record())).rejects.toThrow(
      "LOCAL_CONTROL_RECORD_UNSAFE",
    );
    expect(await readFile(target, "utf8")).toBe("untouched");
    await expect(readControlRecord(file)).rejects.toThrow(
      "LOCAL_CONTROL_RECORD_UNSAFE",
    );
  },
);
async function probeScript(root: string, handshake: boolean) {
  const script = join(root, "probe.mjs"),
    pidFile = join(root, "probe.pid");
  await writeFile(
    script,
    `import process from 'node:process';import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},String(process.pid));${handshake ? "process.send({type:'reinlab.control.ready',pid:process.pid,instance:process.argv[process.argv.indexOf('--instance')+1],port:3001});" : ""}setInterval(()=>{},1000);`,
  );
  return { script, pidFile };
}
it("publishes a record only after its real probe child proves readiness over IPC", async () => {
  const { root, file } = await files(),
    { script } = await probeScript(root, true);
  const started = await startControlProcess({
    script,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    recordFile: file,
    timeoutMs: 2000,
  });
  try {
    expect(await readControlRecord(file)).toEqual({
      pid: started.pid,
      instance: started.instance,
      executable: process.execPath,
      script,
    });
  } finally {
    await started.stop();
  }
  expect(() => process.kill(started.pid, 0)).toThrow();
});
it("live frontend readiness is proved on its own port rather than the control health port", async () => {
  const { root, file } = await files(),
    { script } = await probeScript(root, true);
  const source = await readFile(script, "utf8");
  await writeFile(script, source.replace("port:3001", "port:5183"));
  const started = await startControlProcess({
    script,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    recordFile: file,
    port: 5183,
    timeoutMs: 2000,
  });
  try {
    expect((await readControlRecord(file))?.pid).toBe(started.pid);
  } finally {
    await started.stop();
  }
});
it("cleans only the held child when it never proves ready despite foreign healthy HTTP", async () => {
  const { root, file } = await files(),
    { script, pidFile } = await probeScript(root, false);
  await expect(
    startControlProcess({
      script,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      recordFile: file,
      timeoutMs: 1000,
    }),
  ).rejects.toThrow("LOCAL_CONTROL_UNAVAILABLE");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readControlRecord(file)).toBeUndefined();
});
it("stops the real recorded Node process without relying on the parent ChildProcess handle", async () => {
  const { root, file } = await files(),
    { script } = await probeScript(root, true);
  const started = await startControlProcess({
    script,
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
    recordFile: file,
    timeoutMs: 2000,
  });
  try {
    await stopOwnedControl(file, script, { graceMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(started.pid, 0)).toThrow();
  } finally {
    await started.stop();
  }
});
it("cleans its ready child if safe record publication fails", async () => {
  const { root, file } = await files(),
    { script, pidFile } = await probeScript(root, true),
    target = join(root, "unrelated");
  await writeFile(target, "untouched", { mode: 0o600 });
  await symlink(target, file);
  await expect(
    startControlProcess({
      script,
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      recordFile: file,
      timeoutMs: 2000,
    }),
  ).rejects.toThrow("LOCAL_CONTROL_RECORD_UNSAFE");
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(await readFile(target, "utf8")).toBe("untouched");
});
it("never signals a foreign PID or a PID rebound after the original TERM", async () => {
  const { file } = await files(),
    value = record();
  await writeControlRecord(file, value);
  const signal = vi.fn();
  await stopOwnedControl(file, value.script, {
    inspect: async () => ({ group: value.pid, command: "unrelated-process" }),
    signal,
    graceMs: 0,
  });
  expect(signal).not.toHaveBeenCalled();
  let checks = 0;
  await stopOwnedControl(file, value.script, {
    inspect: async () => ({
      group: value.pid,
      command:
        ++checks === 1
          ? `${value.executable} --import tsx ${value.script} --instance ${value.instance}`
          : "new-foreign-process",
    }),
    signal,
    graceMs: 0,
  });
  expect(signal.mock.calls).toEqual([[value.pid, "SIGTERM"]]);
});
it("recognizes only an exact live command/group when migrating a previous private record", async () => {
  const { file } = await files(),
    value = record();
  await writeFile(
    file,
    JSON.stringify({
      pid: value.pid,
      instance: value.instance,
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const signal = vi.fn();
  let checks = 0;
  await stopOwnedControl(file, value.script, {
    inspect: async () =>
      ++checks === 1
        ? {
            group: value.pid,
            command: `${process.execPath} --import tsx ${value.script} --instance ${value.instance}`,
          }
        : undefined,
    signal,
    graceMs: 0,
  });
  expect(signal.mock.calls).toEqual([[value.pid, "SIGTERM"]]);
  await writeControlRecord(file, value);
  expect(await readControlRecord(file)).toEqual(value);
});
