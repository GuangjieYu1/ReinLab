/**
 * 照片原图与派生图的存放（design/prd/09-explore-v2.md §5.1）。
 *
 * 原图只读保存、不改一个字节：`<root>/dossiers/<dossier>/photos/<photoId>/original.jpg`，
 * 派生图（缩略图 / 预览 / 按需裁切）同目录另存。上传中的分片放在
 * `<root>/photo-uploads/<uploadId>`，完成后移进照片目录。
 */
import { mkdir, lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApiFailure } from "../api/errors";

export type PhotoStore = {
  /** tus 分片落盘目录（整个进程一个）。 */
  uploadsDir: () => string;
  /** 某张照片的目录（绝对路径，只在服务端内部用）。 */
  photoDir: (dossier: string, photoId: string) => string;
  /** 把已经传完的分片挪到照片目录里的 original.jpg。 */
  adoptUpload: (dossier: string, photoId: string, uploadId: string) => Promise<void>;
  write: (dossier: string, photoId: string, name: string, bytes: Buffer) => Promise<void>;
  read: (dossier: string, photoId: string, name: string) => Promise<Buffer | null>;
  /** 原图绝对路径（sharp 直接读文件，不用整张进内存）。 */
  originalPath: (dossier: string, photoId: string) => string;
  remove: (dossier: string, photoId: string) => Promise<void>;
  /** 这份档案占了多少字节。 */
  usedBytes: (dossier: string) => Promise<number>;
};

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function localPhotoStore(root: string): PhotoStore {
  if (!path.isAbsolute(root)) throw new ApiFailure("STORAGE_PATH_INVALID", 503, "照片目录要用绝对路径。");
  const base = (dossier: string) => path.join(root, "dossiers", dossier);
  const photoDir = (dossier: string, photoId: string) => {
    if (!ID.test(photoId)) throw new ApiFailure("PHOTO_NOT_FOUND", 404, "找不到这张照片。");
    return path.join(base(dossier), "photos", photoId);
  };
  const uploadsDir = () => path.join(root, "photo-uploads");
  const writeAtomic = async (directory: string, name: string, bytes: Buffer) => {
    if (!NAME.test(name)) throw new ApiFailure("STORAGE_PATH_INVALID", 503, "文件名不合法。");
    await mkdir(directory, { recursive: true, mode: 0o700 });
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

  return {
    uploadsDir,
    photoDir,
    originalPath: (dossier, photoId) => path.join(photoDir(dossier, photoId), "original.jpg"),
    async adoptUpload(dossier, photoId, uploadId) {
      const source = path.join(uploadsDir(), uploadId);
      const info = await lstat(source).catch(() => null);
      if (!info?.isFile()) throw new ApiFailure("PHOTO_UPLOAD_MISSING", 409, "上传的分片不在了，重新传一次。");
      const directory = photoDir(dossier, photoId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await rename(source, path.join(directory, "original.jpg"));
    },
    async write(dossier, photoId, name, bytes) {
      await writeAtomic(photoDir(dossier, photoId), name, bytes);
    },
    async read(dossier, photoId, name) {
      if (!NAME.test(name)) return null;
      const absolute = path.join(photoDir(dossier, photoId), name);
      const real = await realpath(absolute).catch(() => null);
      if (!real) return null;
      const info = await lstat(real);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      return readFile(real);
    },
    async remove(dossier, photoId) {
      await rm(photoDir(dossier, photoId), { recursive: true, force: true });
    },
    async usedBytes(dossier) {
      const walk = async (target: string): Promise<number> => {
        const info = await stat(target).catch(() => null);
        if (!info) return 0;
        if (info.isFile()) return info.size;
        if (!info.isDirectory()) return 0;
        let total = 0;
        for (const name of await readdir(target)) total += await walk(path.join(target, name));
        return total;
      };
      return walk(base(dossier));
    },
  };
}
