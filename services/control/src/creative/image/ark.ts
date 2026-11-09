/**
 * 火山方舟 Seedream（契约 §12.3）。
 *
 * POST {base}/images/generations，模型名可配（默认 seedream 3.0，支持参考图的那一版）。
 * 返回临时 URL：当场取回字节交给存储层；取不到就报「取回失败」，上层标 unsaved + 留 taskId。
 * 本机还没有真 key，字段解析尽量宽容：url / data[0].url / b64_json 都认。
 */

import type { ImageOutput, ImageProvider, ImageRequest } from './provider';
import { ImageProviderUnavailable, UnsavedImageError } from './provider';
import { imageSizeOf, mimeOfBytes } from './size';

export type ArkConfig = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  size?: string;
  referenceField?: string;
  /** 官方价：单图 ≤261 万像素的单价（元/张）；更大的按大图价。 */
  pricePerImage?: number;
  pricePerLargeImage?: number;
  /** 参考图：第 1 张免费，第 2 张起每张单价（元）。 */
  pricePerExtraReference?: number;
};

const DEFAULT_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const LARGE_PIXELS = 2_610_000;
// 当前账号能用的 Seedream 里最新的一版（4.0 起支持参考图；5.0 pro 出人物更稳）
const DEFAULT_MODEL = 'doubao-seedream-5-0-pro-260628';

/** 按张计价（官方价）：≤261 万像素一档，更大一档；参考图第 1 张免费，第 2 张起加钱。 */
export function imagePriceOf(
  input: { width: number | null; height: number | null; references: number },
  config?: ArkConfig | null,
): { value: number; known: true } {
  const pixels = (input.width ?? 0) * (input.height ?? 0);
  const unit = pixels > LARGE_PIXELS ? (config?.pricePerLargeImage ?? 0.6) : (config?.pricePerImage ?? 0.3);
  const extra = Math.max(0, input.references - 1) * (config?.pricePerExtraReference ?? 0.02);
  return { value: Number((unit + extra).toFixed(6)), known: true };
}

/** 平台错误码 → 人话（原文不贴给作者）。 */
export function humanizeError(status: number, body: string): string {
  const code = /"code"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? '';
  if (/Sensitive|sensitive|审核/i.test(`${code} ${body}`)) return '内容审核没通过，换个描述再试';
  const known: Record<string, string> = {
    'InvalidEndpointOrModel.NotFound': '模型不存在，或账号没开通这个模型',
    AuthenticationError: '出图平台的 key 无效或过期',
    InsufficientBalance: '账号余额不足',
    QuotaExceeded: '这个账号的出图额度用完了',
    RateLimitExceeded: '请求太频繁，稍后再试',
  };
  if (known[code]) return known[code];
  if (status === 401 || status === 403) return '出图平台拒绝了这次请求（key 或权限问题）';
  if (status === 429) return '请求太频繁，稍后再试';
  return `出图平台返回 ${status}${code ? `（${code}）` : ''}`;
}

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
      if (!response.ok) {
        // 平台原文只进日志；给作者的是一句人话
        console.error(JSON.stringify({ code: 'ARK_IMAGE_ERROR', status: response.status, body: text.slice(0, 400) }));
        throw new Error(humanizeError(response.status, text));
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        throw new Error('平台返回读不出来（不是 JSON）。');
      }
      // 平台若回了用量，记下来（花费按官方价另行估算；不编）
      if (parsed.usage) console.log(JSON.stringify({ code: 'ARK_IMAGE_USAGE', usage: parsed.usage }));
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
      const mime = mimeOfBytes(bytes);
      const size = imageSizeOf(bytes, mime);
      return {
        bytes,
        mime,
        ...size,
        taskId,
        cost: imagePriceOf({ width: size.width, height: size.height, references: request.reference ? 1 : 0 }, config),
      };
    },
  };
}
