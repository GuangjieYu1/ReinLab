/**
 * 拆解的描述层（契约 §14.2 第 6 条）：用能看图的模型逐镜读关键帧，写景别/运镜/人物/场景/光线。
 * 纯文字模型（导演）再读这份表就能搭白模、摆走位。
 */

import { readFile } from 'node:fs/promises';

export type VisionConfig = { apiKey: string; baseUrl?: string; model?: string; pricePerMillionInput?: number; pricePerMillionOutput?: number };

export type ShotDescription = { n: number; text: string };

const BASE = (config: VisionConfig) => (config.baseUrl ?? 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');

const PROMPT = `你在看一部短剧的分镜关键帧。按镜写拆解，每镜一行，格式：
镜N：景别（远/全/中/近/特）；运镜（固定/推/拉/摇/移/跟）；人物（几个人、各自身份外观、在画面哪个位置、朝向、正在做什么、表情）；场景（地点、家具摆件）；光线（时辰、天气、主光源）。看不清就写「看不清」，不要编。`;

/** 逐镜（可几镜一组）读关键帧，返回描述。token 用量一起返回。 */
export async function describeShots(
  config: VisionConfig,
  input: { shots: { n: number; startSec: number; endSec: number; keyframes: string[] }[]; title: string },
  options: { group?: number } = {},
): Promise<{ shots: ShotDescription[]; inputTokens: number | null; outputTokens: number | null }> {
  const group = options.group ?? 3;
  const out: ShotDescription[] = [];
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  for (let index = 0; index < input.shots.length; index += group) {
    const batch = input.shots.slice(index, index + group);
    const content: Record<string, unknown>[] = [{ type: 'text', text: `${PROMPT}\n\n视频标题：${input.title}\n本组镜头：` }];
    for (const shot of batch) {
      content.push({ type: 'text', text: `镜${shot.n}（${shot.startSec}–${shot.endSec} 秒）关键帧：` });
      for (const frame of shot.keyframes.slice(0, 2)) {
        const bytes = await readFile(frame);
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } });
      }
    }
    const response = await fetch(`${BASE(config)}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model ?? 'doubao-seed-2-1-pro-260915',
        messages: [{ role: 'user', content }],
        temperature: 0.3,
        max_tokens: 700,
        ...(process.env.REINLAB_VISION_NO_THINK === '1' ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`视觉模型拒绝（${response.status}）：${text.slice(0, 200)}`);
    const body = JSON.parse(text) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const reply = body.choices?.[0]?.message?.content ?? '';
    if (body.usage?.prompt_tokens) inputTokens = (inputTokens ?? 0) + body.usage.prompt_tokens;
    if (body.usage?.completion_tokens) outputTokens = (outputTokens ?? 0) + body.usage.completion_tokens;
    for (const shot of batch) {
      const match = new RegExp(`镜${shot.n}[：:]\\s*([\\s\\S]*?)(?=\\n镜\\d|$)`).exec(reply);
      out.push({ n: shot.n, text: (match?.[1] ?? reply).trim().slice(0, 600) });
    }
  }
  return { shots: out, inputTokens, outputTokens };
}
