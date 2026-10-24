import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, rm, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { accountFiles } from "../src/mcp/files";

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "reinlab-independent-files-"))), dossier = randomUUID();
  const dir = path.join(root, "dossiers", dossier);
  await mkdir(path.join(dir, "findings"), { recursive: true });
  await writeFile(path.join(dir, "findings/original.md"), "old");
  const call = (operation: string, args: Record<string, unknown>, targets = ["findings/"], fault?: "before_commit") => accountFiles(root, dossier, operation, args, targets, fault);
  return { root, dossier, dir, call, close: () => rm(root, { recursive: true, force: true }) };
}

it("independent files: utf8 output survives pipe chunk boundaries exactly", async () => {
  const f = await fixture();
  try {
    const content = "汉字🙂é".repeat(35000);
    await f.call("write", { path: "findings/unicode.md", content });
    expect(await readFile(path.join(f.dir, "findings/unicode.md"), "utf8")).toBe(content);
    const result = await f.call("read", { path: "findings/unicode.md" });
    expect(result.content === content).toBe(true);
  } finally { await f.close(); }
});

it("independent files: concurrent helpers serialize without dropping unrelated writes", async () => {
  const f = await fixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => f.call("write", { path: `findings/concurrent-${n}.md`, content: `value-${n}` })));
    expect(results.map(result => result.status)).toEqual(Array(10).fill("fulfilled"));
    for (let n = 0; n < 10; n++) expect(await readFile(path.join(f.dir, `findings/concurrent-${n}.md`), "utf8")).toBe(`value-${n}`);
    expect(await readFile(path.join(f.dir, "findings/original.md"), "utf8")).toBe("old");
  } finally { await f.close(); }
});

it("independent files: failed patch leaves all content and version history unchanged", async () => {
  const f = await fixture();
  try {
    await expect(f.call("patch", { changes: [{ path: "findings/original.md", content: "partial" }, { path: "findings/new.md", content: "partial" }] }, ["findings/"], "before_commit")).rejects.toThrow();
    expect(await readFile(path.join(f.dir, "findings/original.md"), "utf8")).toBe("old");
    await expect(readFile(path.join(f.dir, "findings/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(path.join(f.root, "mcp-state", f.dossier))).filter(n => n !== "lock")).toEqual([]);
    await expect(f.call("patch", { changes: [{ path: "findings/original.md", content: "first" }, { path: "findings/original.md", content: "second" }] })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
  } finally { await f.close(); }
});

it("independent files: undo requires every original path and preserves later unrelated changes", async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.dir, "results"));
    await writeFile(path.join(f.dir, "results/data.md"), "old-result");
    const version = await f.call("patch", { changes: [{ path: "findings/original.md", content: "new" }, { path: "results/data.md", content: "new-result" }] }, ["findings/", "results/"]);
    await f.call("write", { path: "findings/later.md", content: "keep-later" });
    await expect(f.call("undo", { versionId: version.versionId })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    expect(await readFile(path.join(f.dir, "results/data.md"), "utf8")).toBe("new-result");
    await f.call("undo", { versionId: version.versionId }, ["findings/", "results/"]);
    expect(await readFile(path.join(f.dir, "results/data.md"), "utf8")).toBe("old-result");
    expect(await readFile(path.join(f.dir, "findings/later.md"), "utf8")).toBe("keep-later");
  } finally { await f.close(); }
});

it("independent files: ancestor links, unrelated hardlinks, and special files fail closed without external writes", async () => {
  const f = await fixture();
  try {
    const external = path.join(f.root, "external");
    await mkdir(external); await writeFile(path.join(external, "keep.md"), "external");
    await symlink(external, path.join(f.dir, "findings/linked"));
    await expect(f.call("write", { path: "findings/linked/keep.md", content: "bad" })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    await expect(f.call("list", { path: "findings" })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    expect(await readFile(path.join(external, "keep.md"), "utf8")).toBe("external");
    await rm(path.join(f.dir, "findings/linked"));
    await link(path.join(external, "keep.md"), path.join(f.dir, "findings/hard.md"));
    await expect(f.call("write", { path: "findings/other.md", content: "bad" })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    await rm(path.join(f.dir, "findings/hard.md"));
    execFileSync("mkfifo", [path.join(f.dir, "findings/fifo")]);
    await expect(f.call("write", { path: "findings/other.md", content: "bad" })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    expect(await readFile(path.join(f.dir, "findings/original.md"), "utf8")).toBe("old");
  } finally { await f.close(); }
});

it("independent files: retains latest fifty versions and rejects expired undo", async () => {
  const f = await fixture();
  try {
    const first = await f.call("write", { path: "findings/original.md", content: "0" });
    let last: Record<string, unknown> = first;
    for (let n = 1; n < 52; n++) last = await f.call("write", { path: "findings/original.md", content: String(n) });
    const history = await readdir(path.join(f.root, "mcp-state", f.dossier));
    expect(history.filter(n => n.endsWith(".json"))).toHaveLength(50);
    await expect(f.call("undo", { versionId: first.versionId })).rejects.toMatchObject({ code: "FILE_SCOPE_DENIED" });
    await f.call("undo", { versionId: last.versionId });
    expect(await readFile(path.join(f.dir, "findings/original.md"), "utf8")).toBe("50");
  } finally { await f.close(); }
// 52 real Python/fsync writes plus undo; keep every retention/expiry assertion.
}, 30_000);
