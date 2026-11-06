/**
 * 按章抽取（1B 契约 §5.1 的「导入」）：一段原文 → 实体、事件、别名合并、共指候选。
 *
 * 一次调用一章：模型只做抽取，不做决定；时间写法原样保留（由故事时间解析器认，认不出就带疑点），
 * 古地名给候选不硬定，叙述性质按原文判断。输出形状写死在系统提示词里。
 */

import type { CreativeProvenance as Provenance } from '@reinlab/contracts';
import { clip } from './text';

export type ExtractedEntity = {
  kind: 'person' | 'place' | 'item' | 'org';
  name: string;
  aliases: string[];
  summary?: string;
  /** 原文位置（段、句）与原句。 */
  para: number;
  sentence: number;
  quote: string;
  basis: 'explicit' | 'inferred';
  candidates?: { name: string; why: string }[];
  doubt?: string;
};

export type ExtractedEvent = {
  title: string;
  what: string;
  kind: 'stay' | 'travel' | 'interaction' | 'birth' | 'death' | 'other';
  participants: { name: string; as: 'actor' | 'present' | 'remote' | 'mentioned' }[];
  place: string | null;
  start: string;
  end: string;
  narrative: 'fact' | 'hearsay' | 'dream' | 'hypothetical' | 'flashback';
  para: number;
  sentence: number;
  quote: string;
  doubt?: string;
};

export type ExtractedMerge = {
  name: string;
  candidates: string[];
  why: string;
  para: number;
  sentence: number;
  quote: string;
};

export type Extraction = {
  entities: ExtractedEntity[];
  events: ExtractedEvent[];
  merges: ExtractedMerge[];
};

export type ChapterExtractor = (input: {
  chapterTitle: string;
  text: string;
  /** 已入账的实体和人名，避免重复建。 */
  known: { name: string; kind: string }[];
  calendarHint: string;
}) => Promise<{ extraction: Extraction; usage: { inputTokens: number | null; outputTokens: number | null } }>;

const ENTITY_KINDS = new Set(['person', 'place', 'item', 'org']);
const EVENT_KINDS = new Set(['stay', 'travel', 'interaction', 'birth', 'death', 'other']);
const PARTICIPATION = new Set(['actor', 'present', 'remote', 'mentioned']);
const NARRATIVE = new Set(['fact', 'hearsay', 'dream', 'hypothetical', 'flashback']);

const SYSTEM = `你在给一部小说建世界观账本。用户给你一章原文，请抽出这一章里出现的人物、地点、物件、组织和事件。

只输出一个 JSON 对象，不要别的文字：
{
  "entities": [{"kind":"person|place|item|org","name":"","aliases":[],"summary":"","para":0,"sentence":0,"quote":"","basis":"explicit|inferred","candidates":[{"name":"","why":""}],"doubt":""}],
  "events": [{"title":"","what":"","kind":"stay|travel|interaction|birth|death|other","participants":[{"name":"","as":"actor|present|remote|mentioned"}],"place":null,"start":"","end":"","narrative":"fact|hearsay|dream|hypothetical|flashback","para":0,"sentence":0,"quote":"","doubt":""}],
  "merges": [{"name":"","candidates":[""],"why":"","para":0,"sentence":0,"quote":""}]
}

底线：
- 只抽原文里真的写到的。原文没写的地点、时间就留空字符串，不补。
- 时间原样抄原文写法（「康熙二十三年三月初七」「三天后」），不要自己换算成公历。
- para 是段落序号（从 0 起，按空行分段），sentence 是这一段里的第几句（从 0 起），quote 是那一句原文（照抄，不超过 60 字）。
- 人物说了死了、传说他死了，都只是「传闻」：narrative 写 hearsay，不要当成事实。
- 「他」「那老者」这类共指放进 merges，candidates 给可能的已有名字；拿不准就在 doubt 里写清。
- 古地名、旧称给 candidates（现代地名或范围），说明依据；查不到就留空并写 doubt。
- 同一个人在这一章里的不同称呼（姓、字、号，「生」「君」「叟」这类）写进 aliases；拿不准是不是同一人放进 merges。
- 原文里有年号（康熙十七年）、干支、农历日期就原样抄进 start/end，不要空着。
- 已经入账的人名不要再建一遍：用同名即可，事件里照样引用。`;

const extractJson = (text: string): unknown => {
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

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

/** 把模型输出收拾成能落库的形状：不合格的整条丢掉，不补。 */
export function normalizeExtraction(raw: unknown): Extraction {
  const payload = (raw ?? {}) as Record<string, unknown>;
  const entities: ExtractedEntity[] = [];
  const events: ExtractedEvent[] = [];
  const merges: ExtractedMerge[] = [];
  for (const item of Array.isArray(payload.entities) ? payload.entities : []) {
    const row = item as Record<string, unknown>;
    const kind = String(row.kind ?? '');
    const name = clip(row.name, 60).trim();
    if (!ENTITY_KINDS.has(kind) || !name) continue;
    entities.push({
      kind: kind as ExtractedEntity['kind'],
      name,
      aliases: (Array.isArray(row.aliases) ? row.aliases : []).map((alias) => clip(alias, 60).trim()).filter(Boolean).slice(0, 8),
      ...(row.summary ? { summary: clip(row.summary, 500) } : {}),
      para: num(row.para),
      sentence: num(row.sentence),
      quote: clip(row.quote, 200),
      basis: row.basis === 'inferred' ? 'inferred' : 'explicit',
      ...(Array.isArray(row.candidates)
        ? {
            candidates: row.candidates
              .map((candidate) => {
                const entry = candidate as Record<string, unknown>;
                return { name: clip(entry.name, 80), why: clip(entry.why, 300) };
              })
              .filter((candidate) => candidate.name)
              .slice(0, 5),
          }
        : {}),
      ...(row.doubt ? { doubt: clip(row.doubt, 300) } : {}),
    });
  }
  for (const item of Array.isArray(payload.events) ? payload.events : []) {
    const row = item as Record<string, unknown>;
    const title = clip(row.title, 120).trim();
    if (!title) continue;
    const kind = String(row.kind ?? 'other');
    events.push({
      title,
      what: clip(row.what, 500),
      kind: (EVENT_KINDS.has(kind) ? kind : 'other') as ExtractedEvent['kind'],
      participants: (Array.isArray(row.participants) ? row.participants : [])
        .map((participant) => {
          const entry = participant as Record<string, unknown>;
          const as = String(entry.as ?? 'actor');
          return { name: clip(entry.name, 60).trim(), as: (PARTICIPATION.has(as) ? as : 'mentioned') as ExtractedEvent['participants'][number]['as'] };
        })
        .filter((participant) => participant.name)
        .slice(0, 20),
      place: row.place ? clip(row.place, 80).trim() || null : null,
      start: clip(row.start, 80),
      end: clip(row.end, 80),
      narrative: (NARRATIVE.has(String(row.narrative)) ? String(row.narrative) : 'fact') as ExtractedEvent['narrative'],
      para: num(row.para),
      sentence: num(row.sentence),
      quote: clip(row.quote, 200),
      ...(row.doubt ? { doubt: clip(row.doubt, 300) } : {}),
    });
  }
  for (const item of Array.isArray(payload.merges) ? payload.merges : []) {
    const row = item as Record<string, unknown>;
    const name = clip(row.name, 60).trim();
    const candidates = (Array.isArray(row.candidates) ? row.candidates : []).map((value) => clip(value, 60).trim()).filter(Boolean);
    if (!name || candidates.length < 1) continue;
    merges.push({
      name,
      candidates: candidates.slice(0, 5),
      why: clip(row.why, 500),
      para: num(row.para),
      sentence: num(row.sentence),
      quote: clip(row.quote, 200),
    });
  }
  return { entities, events, merges };
}

export type ChapterExtractorDeps = {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  session?: string;
  transport?: typeof fetch;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  maxTokens?: number;
};

/** 一章一次调用：形状写死，读回来看不合格的丢掉。 */
export function createChapterExtractor(deps: ChapterExtractorDeps): ChapterExtractor {
  const transport = deps.transport ?? fetch;
  const base = deps.baseUrl.replace(/\/+$/, '');
  const endpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  return async (input) => {
    const prompt = [
      `章名：${input.chapterTitle}`,
      input.known.length ? `已入账的实体：${input.known.slice(0, 80).map((item) => `${item.name}（${item.kind}）`).join('、')}` : '已入账的实体：无',
      `历法提示：${input.calendarHint}`,
      '原文：',
      input.text,
    ].join('\n');
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
        max_tokens: deps.maxTokens ?? 4096,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`抽取模型返回 ${response.status}：${clip(text, 200)}`);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('抽取模型返回的不是 JSON。');
    }
    const content = (payload as { content?: { type?: string; text?: string }[] }).content ?? [];
    const body = content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n');
    let parsed = extractJson(body);
    if (!parsed) {
      // 没读到 JSON：多半是被写成了散文或截断。再要一次，只要 JSON。
      const retry = await transport(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': deps.apiKey,
          'anthropic-version': '2023-06-01',
          ...(deps.session ? { 'x-opencode-session': deps.session } : {}),
        },
        body: JSON.stringify({
          model: deps.model,
          max_tokens: deps.maxTokens ?? 4096,
          system: SYSTEM,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: clip(body, 2000) },
            { role: 'user', content: '只输出那个 JSON 对象，不要任何解释或前后缀。' },
          ],
        }),
        signal: AbortSignal.timeout(240_000),
      });
      const retryText = await retry.text();
      try {
        const retryPayload = JSON.parse(retryText) as { content?: { type?: string; text?: string }[] };
        const retryBody = (Array.isArray(retryPayload.content) ? retryPayload.content : [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n');
        parsed = extractJson(retryBody);
      } catch {
        parsed = null;
      }
      if (!parsed) throw new Error('抽取结果读不出来（没有 JSON）。');
    }
    const usage = (payload as { usage?: { input_tokens?: number; output_tokens?: number } }).usage ?? {};
    return {
      extraction: normalizeExtraction(parsed),
      usage: {
        inputTokens: Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null,
        outputTokens: Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null,
      },
    };
  };
}

/**
 * 长文分块：按段落拼到 maxChars 一块，段号带上偏移——抽取的时间、出处都不丢。
 * 文言一章常常两三千字，一次塞给模型容易写出半句话，宁可分块。
 */
export function splitIntoChunks(
  text: string,
  maxChars = 3000,
): { text: string; paraOffset: number }[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: { text: string; paraOffset: number }[] = [];
  let current: string[] = [];
  let paraOffset = 0;
  let size = 0;
  paragraphs.forEach((paragraph, index) => {
    if (size > 0 && size + paragraph.length > maxChars) {
      chunks.push({ text: current.join('\n\n'), paraOffset });
      paraOffset = index;
      current = [];
      size = 0;
    }
    current.push(paragraph);
    size += paragraph.length;
  });
  if (current.length) chunks.push({ text: current.join('\n\n'), paraOffset });
  return chunks.length ? chunks : [{ text, paraOffset: 0 }];
}

/** 出处：章、段、句 + 原句，附原文版本。 */
export function provenanceOf(input: {
  workId: string;
  textVersion: number;
  chapterId: string;
  para: number;
  sentence: number;
  quote: string;
  basis: 'explicit' | 'inferred';
  why?: string;
}): Provenance {
  return {
    basis: input.basis,
    by: 'importer',
    source: {
      workId: input.workId,
      textVersion: input.textVersion,
      chapterId: input.chapterId,
      para: input.para,
      sentence: input.sentence,
      quote: input.quote,
    },
    ...(input.why ? { why: input.why } : {}),
  };
}
