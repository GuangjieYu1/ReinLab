/**
 * 一次结构化模型调用（写作助手、设定顾问共用）：形状写死在系统提示词里，
 * 读回来只认 JSON。网关的 base 有两种写法（…/anthropic 或 …/v1），按结尾补。
 */

import { clip } from './text';

export type ModelDeps = {
  baseUrl: string;
  apiKey: string;
  model: string;
  session?: string;
  transport?: typeof fetch;
  maxTokens?: number;
};

export type ModelResult = {
  text: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
};

export const extractJson = (text: string): unknown => {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const slice = candidate.slice(start);
  for (let end = slice.length; end > 1; end -= 1) {
    try {
      return JSON.parse(slice.slice(0, end));
    } catch {
      continue;
    }
  }
  return null;
};

export async function callStructured(
  deps: ModelDeps,
  input: { system: string; prompt: string; maxTokens?: number; timeoutMs?: number },
): Promise<ModelResult> {
  const transport = deps.transport ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, '');
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  const response = await transport(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': deps.apiKey,
      'anthropic-version': '2023-06-01',
      ...(deps.session ? { 'x-opencode-session': deps.session } : {}),
    },
    body: JSON.stringify({
      model: deps.model,
      max_tokens: input.maxTokens ?? deps.maxTokens ?? 4096,
      system: input.system,
      messages: [{ role: 'user', content: input.prompt }],
    }),
    signal: AbortSignal.timeout(input.timeoutMs ?? 240_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`模型返回 ${response.status}：${clip(raw, 300)}`);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('模型返回的不是 JSON。');
  }
  const content = (payload as { content?: { type?: string; text?: string }[] }).content ?? [];
  const text = content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
  const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
  return {
    text,
    usage: {
      inputTokens: Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null,
      outputTokens: Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null,
    },
  };
}
