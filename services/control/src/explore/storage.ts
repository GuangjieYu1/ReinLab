/**
 * 探索台的文件存放（参考图副本、以后的 PDF 与地图快照）。
 *
 * 本机就把文件放在档案自己的目录下，目录 0700、文件 0600；业务层只拿到
 * 相对路径，读的时候再拼回根目录并挡住越界。换对象存储时只换这一个实现。
 */
import { mkdir, open, readFile, realpath, rename, rm, lstat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ApiFailure } from "../api/errors";
import type { ExploreStorage } from "./refs";

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
};

export function localExploreStorage(root: string): ExploreStorage {
  const sub = (dossier: string, kind: string) => path.join(root, "dossiers", dossier, kind);
  const safeJoin = (base: string, name: string) => {
    const resolved = path.resolve(base, name);
    if (resolved !== base && !resolved.startsWith(base + path.sep))
      throw new ApiFailure("STORAGE_PATH_INVALID", 503, "文件路径不在这份档案里。");
    return resolved;
  };
  /** 写一份文件：0700 目录、0600、先写临时文件再改名。 */
  const writeAtomic = async (directory: string, name: string, bytes: Buffer) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new ApiFailure("STORAGE_PATH_INVALID", 503, "存放目录不可用。");
    const temporary = path.join(directory, `.${name}.${randomUUID()}.pending`);
    const handle = await open(temporary, "w", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path.join(directory, name)).catch(async (error) => {
      await rm(temporary, { force: true });
      throw error;
    });
  };
  const readFileInside = async (directory: string, name: string) => {
    const absolute = safeJoin(directory, name);
    const real = await realpath(absolute).catch(() => null);
    if (!real) return null;
    const info = await lstat(real);
    if (!info.isFile()) return null;
    const bytes = await readFile(real);
    const ext = path.extname(real).slice(1).toLowerCase();
    return { bytes, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" };
  };
  if (!path.isAbsolute(root)) throw new ApiFailure("STORAGE_PATH_INVALID", 503, "存放目录必须用绝对路径。");

  const refsDir = (dossier: string) => path.join(root, "dossiers", dossier, "refs");

  const packDir = (dossier: string, packId: string) =>
    path.join(root, "dossiers", dossier, "offline", packId);

  /** 字形按账户共用一份：不同离线包要的是同一批拉丁区段。 */
  const fontsDir = () => path.join(root, "fonts");

  /** 包内相对名 → 绝对路径；不接受跳出该包目录的名字。 */
  const packAssetInside = (base: string, name: string) => {
    const resolved = path.resolve(base, name);
    if (!resolved.startsWith(base + path.sep))
      throw new ApiFailure("STORAGE_PATH_INVALID", 503, "文件路径不在这个离线包里。");
    return resolved;
  };

  /** 相对路径 → 绝对路径，且必须落在这份档案的目录里。 */
  const resolveInside = (dossier: string, relative: string) => {
    const base = refsDir(dossier);
    const resolved = path.resolve(base, relative);
    if (resolved !== base && !resolved.startsWith(base + path.sep))
      throw new ApiFailure("STORAGE_PATH_INVALID", 503, "文件路径不在这份档案里。");
    return resolved;
  };

  return {
    // 地图快照：snapshots/<revision>/<key>.png
    async saveSnapshot({ dossier, revision, key, bytes }) {
      const directory = sub(dossier, "snapshots");
      await writeAtomic(path.join(directory, String(revision)), `${key}.png`, bytes);
      return `${revision}/${key}.png`;
    },
    async readSnapshot({ dossier, path: relative }) {
      return readFileInside(sub(dossier, "snapshots"), relative);
    },
    // 计划书 PDF：books/<artifactId>.pdf
    async saveBook({ dossier, artifactId, bytes }) {
      const directory = sub(dossier, "books");
      await writeAtomic(directory, `${artifactId}.pdf`, bytes);
      return `${artifactId}.pdf`;
    },
    async readBook({ dossier, path: relative }) {
      return readFileInside(sub(dossier, "books"), relative);
    },

    // 离线包：offline/<packId>/tiles/<z>/<x>/<y>.pbf、offline/<packId>/glyphs/…
    // 名字由服务端拼，仍然挡住越界（包目录之外一律不读不写）。
    async savePackAsset({ dossier, packId, name, bytes }) {
      const base = packDir(dossier, packId);
      const absolute = packAssetInside(base, name);
      await writeAtomic(path.dirname(absolute), path.basename(absolute), bytes);
    },
    async saveFontAsset({ name, bytes }) {
      const base = fontsDir();
      const absolute = packAssetInside(base, name);
      await writeAtomic(path.dirname(absolute), path.basename(absolute), bytes);
    },
    async readFontAsset({ name }) {
      const absolute = packAssetInside(fontsDir(), name);
      const real = await realpath(absolute).catch(() => null);
      if (!real) return null;
      const info = await lstat(real);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      return readFile(real);
    },

    async readPackAsset({ dossier, packId, name }) {
      const absolute = packAssetInside(packDir(dossier, packId), name);
      const real = await realpath(absolute).catch(() => null);
      if (!real) return null;
      const info = await lstat(real);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      return readFile(real);
    },

    async saveRef({ dossier, refId, ext, bytes }) {
      const directory = refsDir(dossier);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ApiFailure("STORAGE_PATH_INVALID", 503, "存放目录不可用。");
      const name = `${refId}.${ext}`;
      const temporary = path.join(directory, `.${name}.${randomUUID()}.pending`);
      const handle = await open(temporary, "w", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path.join(directory, name)).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
      // 只回相对名：绝对路径不出业务层。
      return name;
    },

    async readRef({ dossier, path: relative }) {
      const absolute = resolveInside(dossier, relative);
      const real = await realpath(absolute).catch(() => null);
      if (!real) return null;
      const info = await lstat(real);
      if (!info.isFile()) return null;
      const bytes = await readFile(real);
      const ext = path.extname(real).slice(1).toLowerCase();
      return { bytes, mime: MIME_BY_EXT[ext] ?? "application/octet-stream" };
    },

    async removeRef({ dossier, path: relative }) {
      await rm(resolveInside(dossier, relative), { force: true });
    },
  };
}
