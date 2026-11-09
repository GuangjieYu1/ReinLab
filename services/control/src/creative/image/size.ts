/** 从图片字节里读宽高（PNG / JPEG）。读不出就是 null，不猜。 */

export const mimeOfBytes = (bytes: Uint8Array): string => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'application/octet-stream';
};

export function imageSizeOf(bytes: Uint8Array, mime = mimeOfBytes(bytes)): { width: number | null; height: number | null } {
  if (mime === 'image/png' && bytes.length > 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mime === 'image/jpeg') {
    // 扫 SOFn 段（C0–CF，跳过 C4/C8/CC）
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        return { width, height };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}
