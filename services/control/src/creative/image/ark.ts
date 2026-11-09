/**
 * 火山方舟 Seedream（契约 §12.3）。
 *
 * POST {base}/images/generations，模型名可配（默认 seedream 3.0，支持参考图的那一版）。
 * 返回临时 URL：当场取回字节交给存储层；取不到就报「取回失败」，上层标 unsaved + 留 taskId。
 * 本机还没有真 key，字段解析尽量宽容：url / data[0].url / b64_json 都认。
 */

import type { ImageOutput, ImageProvider, ImageRequest } from './provider';
import { ImageProviderUnavailable, UnsavedImageError } from './provider';

export type ArkConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  size?: string;
  referenceField?: string;
};

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_MODEL = 'doubao-seedream-3-0-t2i-250415';

const mimeOf = (bytes: Uint8Array): string => {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'application/octet-stream';
};

const sizeOf = (bytes: Uint8Array, mime: string): { width: number | null; height: number | null } => {
  if (mime === 'image/png' && bytes.length > 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  return { width: null, height: null };
};

export function createArkProvider(config: ArkConfig | null): ImageProvider {
  const apiKey = config?.apiKey ?? '';
  const base = (config?.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const model = config?.model ?? DEFAULT_MODEL;
  return {
    name: 'volcengine-ark',
    model,
    available: () => Boolean(apiKey),
    async generate(request: ImageRequest): Promise<ImageOutput> {
      if (!apiKey) throw new ImageProviderUnavailable();
      const body: Record<string, unknown> = {
        model,
        prompt: request.prompt,
        size: request.size ?? config?.size ?? '1024x1536',
        response_format: 'url',
        watermark: false,
      };
      if (request.reference) {
        const base64 = Buffer.from(request.reference.bytes).toString('base64');
        body[config?.referenceField ?? 'image'] = `data:${request.reference.mime};base64,${base64}`;
      }
      const response = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`平台拒绝（${response.status}）：${text.slice(0, 200)}`);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error('平台返回读不出来（不是 JSON）。');
      }
      const data = Array.isArray(parsed.data) ? (parsed.data as Record<string, unknown>[]) : [];
      const first = data[0] ?? parsed;
      const taskId = String(first.task_id ?? first.id ?? parsed.id ?? '') || null;
      const url = typeof first.url === 'string' ? first.url : null;
      const b64 = typeof first.b64_json === 'string' ? first.b64_json : null;
      let bytes: Uint8Array;
      if (b64) bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      else if (url) {
        try {
          const image = await fetch(url, { signal: AbortSignal.timeout(120_000) });
          if (!image.ok) throw new Error(`图取不回来（${image.status}）。`);
          bytes = new Uint8Array(await image.arrayBuffer());
        } catch (error) {
          // 图出了、取不回来：留地址和任务号，上层标 unsaved，retry 只取回
          throw new UnsavedImageError(
            `图取不回来：${error instanceof Error ? error.message : String(error)}`,
            { pendingUrl: url, taskId },
          );
        }
      } else throw new Error('平台没给图（只有任务号，还没完成）。');
      const mime = mimeOf(bytes);
      return { bytes, mime, ...sizeOf(bytes, mime), taskId, cost: null };
    },
  };
}
