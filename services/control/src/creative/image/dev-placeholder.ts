/**
 * 开发占位图（只在 REINLAB_IMAGE_DEV=placeholder 时启用）。
 *
 * 用它是为了让页面在拿到真 key 之前能把「四格出图 → 选用 → 头像」这套流程走通；
 * 产出的图很丑、标着 dev-placeholder，**不能当验收结果**（验收必须用真平台）。
 */

import { deflateSync } from 'node:zlib';
import type { ImageOutput, ImageProvider, ImageRequest } from './provider';

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), Buffer.from(data)])), 0);
  return Buffer.concat([head, Buffer.from(data), crc]);
};

/** 纯色 PNG（每格不同颜色，方便页面区分）。 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
  return new Uint8Array(png);
}

const PALETTE: Record<string, [number, number, number]> = {
  portrait: [196, 178, 148],
  front: [168, 186, 196],
  side: [176, 196, 168],
  back: [196, 168, 180],
};

export function createPlaceholderProvider(): ImageProvider {
  return {
    name: 'dev-placeholder',
    model: 'placeholder-1x',
    available: () => true,
    async generate(request: ImageRequest): Promise<ImageOutput> {
      const view = Object.keys(PALETTE).find((key) => request.prompt.includes(key)) ?? 'portrait';
      const bytes = solidPng(384, 512, PALETTE[view]!);
      return { bytes, mime: 'image/png', width: 384, height: 512, taskId: `dev-${view}`, cost: { value: null, known: false } };
    },
  };
}
