import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
it("入口配置与子进程强制禁用自动升级并保留模型和插件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reinlab-entry-lock-")),
    root = join(dir, "data"),
    executable = join(dir, "probe.mjs");
  await mkdir(root);
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {readFile,writeFile} from 'node:fs/promises';const config=JSON.parse(await readFile(process.env.OPENSCIENCE_CONFIG_DIR+'/openscience.json','utf8'));await writeFile(process.env.TEST_ACCOUNT_REPORT,JSON.stringify({config,autoUpdate:process.env.OPENSCIENCE_DISABLE_AUTOUPDATE}));process.exit(17);\n`,
  );
  await chmod(executable, 0o700);
  const report = join(dir, "result.json"),
    entry = pathToFileURL(resolve("infra/fly/account-entrypoint.mjs")).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const {startAccount}=await import(${JSON.stringify(entry)});await startAccount({root:process.env.TEST_ACCOUNT_ROOT,executable:process.env.TEST_ACCOUNT_EXECUTABLE});`,
    ],
    {
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        TEST_ACCOUNT_ROOT: root,
        TEST_ACCOUNT_EXECUTABLE: executable,
        TEST_ACCOUNT_REPORT: report,
        OPENSCIENCE_AUTH_TOKEN: "a".repeat(43),
        REINLAB_CONTAINER_SECRET: "b".repeat(43),
        REINLAB_ACCOUNT_ID: "12345678-1234-4234-8234-123456789abc",
        OPENSCIENCE_DISABLE_AUTOUPDATE: "0",
        OPENSCIENCE_DEFAULT_MODEL: "deepseek/deepseek-v4-flash",
      },
    },
  );
  try {
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("ENTRY_TEST_TIMEOUT"));
      }, 5000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        done(code);
      });
    });
    expect(code).toBe(17);
    const observed = JSON.parse(await readFile(report, "utf8"));
    expect(observed.config).toEqual({
      autoupdate: false,
      plugin: ["file:///opt/reinlab/plugin/index.js"],
      model: "deepseek/deepseek-v4-flash",
    });
    expect(observed.autoUpdate).toBe("1");
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
