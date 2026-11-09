/**
 * 出图的平台层（MVP-2 契约 §12.3「平台做成可换的一层」）。
 *
 * 只用一件事：给一段描述（可选参考图），拿回一张图的字节。谁能出、多少钱、多慢，都由实现决定。
 */

import type { CreativeCny } from '@reinlab/contracts';

export type ImageRequest = {
  prompt: string;
  /** 参考图（三视图拿立绘当参考；只重出某格时拿 from 版的立绘当参考）。 */
  reference?: { bytes: Uint8Array; mime: string } | null;
  size?: string;
};

export type ImageOutput = {
  bytes: Uint8Array;
  mime: string;
  width: number | null;
  height: number | null;
  /** 平台任务号：待保存时用它只重试取回。 */
  taskId: string | null;
  /** 平台给的用量花费；没给就是 null（不记 0）。 */
  cost: CreativeCny | null;
};

export interface ImageProvider {
  name: string;
  model: string;
  /** 平台配好了没有（没 key 就是 false，出图直接报错，不伪造成功）。 */
  available(): boolean;
  generate(request: ImageRequest): Promise<ImageOutput>;
}

/** 图出了但没取回来：留着平台的临时地址和任务号，之后只重试取回、不再付费。 */
export class UnsavedImageError extends Error {
  pendingUrl: string | null;
  taskId: string | null;
  constructor(message: string, input: { pendingUrl?: string | null; taskId?: string | null } = {}) {
    super(message);
    this.pendingUrl = input.pendingUrl ?? null;
    this.taskId = input.taskId ?? null;
  }
}

export class ImageProviderUnavailable extends Error {
  constructor(message = '出图的平台还没配好（缺 ARK_API_KEY），出不了图。') {
    super(message);
  }
}
