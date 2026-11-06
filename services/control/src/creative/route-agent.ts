/**
 * AI 推断路线（design/prd/19-creative.md §4、20-creative-contract.md §2）。
 *
 * leg 算不出来时自动发起：由这个角色参照地形、水系、关隘、古道去画一条有依据的路线。
 * 它拿到的工具：全网搜索、读网页全文、查这一段路周边的 OSM 水文与古道、交路线。
 * 底线写在提示词里（不教它做事）：查不到就说查不到，不许拿直线冒充路线，
 * 编不出来就放弃并说明断在哪。
 *
 * 结果立刻参与轨迹和检查（虚线 +「推断」标），但只是提议：作者确认后才成为正式路线。
 * 花费只记不拦；用量未知就记未知，不记 0。
 */

import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { GeoJSON, Proposal, CreativeRouteLeg } from '@reinlab/contracts';
import { ApiFailure } from '../api/errors';
import { runCheck } from './check';
import { appendEvents } from './events';
import { buildLegs, pathDistanceKm } from './routing';
import { saveCheck } from './service';
import { recordUsage } from '../run/usage';
import { recordSpend } from '../budget/spend';
import { loadWorld, type WorldState } from './service';
import { modeOf } from './world';
import { clip } from './text';

const MAX_STEPS = 8;
const MAX_TOKENS = 2048;
/** 整段推断的硬上限：卡住就照实说没算出来，别让页面一直等。 */
const DEADLINE_MS = 480_000;
/** 搜索/读网页的总次数上限：防止来回翻资料把时间和钱都花掉。 */
const MAX_WEB_CALLS = 4;

export type RouteInferenceDeps = {
  /** 模型网关（Anthropic 兼容），没配就退回「不可用」，不伪造结果。 */
  baseUrl: string;
  apiKey: string;
  model: string;
  session?: string;
  provider: string;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
  transport?: typeof fetch;
  /**
   * 搜索与读网页走 DeepSeek 官方那一套（和模型网关是两把 key、两个域）：
   * 网关换了也不影响查资料。没配就照实说「查不了」。
   */
  web?: { baseUrl: string; apiKey: string; feeCny?: number } | null;
  /** 搜索/读网页按次计费（官方 ¥5 / 千次）。 */
  webCallFeeCny?: number;
};

export type RouteInferenceRequest = {
  account: string;
  dossier: string;
  legId: string;
  from: { name: string; point: [number, number] };
  to: { name: string; point: [number, number] };
  mode: { name: string; kmPerHour: number } | null;
  failure: string | null;
  hint?: string;
  /** 已知的路网事实（不连通 / 没边），让模型知道该考据什么。 */
  networkState: string;
};

export type RouteInferenceResult =
  | {
      ok: true;
      path: GeoJSON.LineString;
      why: string;
      sources: { title: string; url?: string }[];
      doubts: string[];
      usage: { inputTokens: number | null; outputTokens: number | null; webCalls: number; known: boolean };
    }
  | { ok: false; failure: string; usage: { inputTokens: number | null; outputTokens: number | null; webCalls: number; known: boolean } };

const SYSTEM = `你在一部小说的创作台里补画一段推断路线。作者已经写好了人物从 A 到 B 的行程，但按现有路网算不出这条路。

你的任务：参照这一带的真实地形、水系、关隘和当时的古道，画一条合理的路线，并写清依据。

工具：
- web_search：查这段路的历史记载、古道、驿站、渡口、山口。
- web_fetch：读网页全文（搜索结果只是一句摘要，关键依据要读全文）。
- terrain_around：查某一点附近的 OSM 水系、山口、浅滩和山道。这是地理事实，不是历史。
- submit_route：交出路线（经纬度数组）、依据和来源。

底线：
- 资料查够就交（最多查 4 次）；查不到就说查不到。
- 依据里只写你真的读到的；没读全的内容标成未读，不猜。
- 不许拿直线冒充路线：至少三个点，且要绕开明显不可能的地方（水面、绝壁、没有渡口的大河）。
- 想不出有依据的路线就放弃（不发 submit_route），说明断在哪一步、缺什么资料。
- 坐标是 WGS84 经纬度，顺序 [lng, lat]。`;

const toolSchema = (name: string, description: string, properties: Record<string, unknown>, required: string[]) => ({
  name,
  description,
  input_schema: { type: 'object', properties, required },
});

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

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

const straightKm = (a: [number, number], b: [number, number]) => {
  const meters = 111_320;
  const dx = (b[0] - a[0]) * meters * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  const dy = (b[1] - a[1]) * meters;
  return Math.hypot(dx, dy) / 1000;
};

/** 模型交上来的路线要能被当路线用：至少三个点、落在这一带、不是拿直线顶替。 */
export function validateSubmittedRoute(
  raw: unknown,
  request: RouteInferenceRequest,
): { ok: true; path: GeoJSON.LineString; why: string; sources: { title: string; url?: string }[]; doubts: string[] } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: '没有交路线。' };
  const payload = raw as {
    coordinates?: unknown;
    why?: unknown;
    sources?: unknown;
    doubts?: unknown;
  };
  if (!Array.isArray(payload.coordinates) || payload.coordinates.length < 3)
    return { ok: false, reason: '至少要三个点；两个点就是直线，不能用。' };
  const coordinates: [number, number][] = [];
  for (const item of payload.coordinates) {
    if (!Array.isArray(item) || item.length < 2) return { ok: false, reason: '坐标格式不对。' };
    const lng = Number(item[0]);
    const lat = Number(item[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90)
      return { ok: false, reason: '坐标超出经纬度范围。' };
    coordinates.push([lng, lat]);
  }
  const lngs = [request.from.point[0], request.to.point[0]];
  const lats = [request.from.point[1], request.to.point[1]];
  const spanLng = Math.max(...lngs) - Math.min(...lngs);
  const spanLat = Math.max(...lats) - Math.min(...lats);
  const marginLng = Math.max(0.05, spanLng * 0.6);
  const marginLat = Math.max(0.05, spanLat * 0.6);
  for (const [lng, lat] of coordinates)
    if (
      lng < Math.min(...lngs) - marginLng ||
      lng > Math.max(...lngs) + marginLng ||
      lat < Math.min(...lats) - marginLat ||
      lat > Math.max(...lats) + marginLat
    )
      return { ok: false, reason: '路线跑出这一带了，不像这两点之间的路。' };
  const path: GeoJSON.LineString = { type: 'LineString', coordinates };
  const straight = straightKm(request.from.point, request.to.point);
  const length = pathDistanceKm(path);
  if (straight > 1 && length < straight * 1.05)
    return { ok: false, reason: '这条线几乎是直线，不能当路线用。' };
  const why = typeof payload.why === 'string' ? payload.why.trim() : '';
  if (why.length < 10) return { ok: false, reason: '没有写依据。' };
  const sources: { title: string; url?: string }[] = [];
  if (Array.isArray(payload.sources))
    for (const item of payload.sources.slice(0, 12)) {
      if (!item || typeof item !== 'object') continue;
      const title = String((item as { title?: unknown }).title ?? '').trim();
      if (!title) continue;
      const url = String((item as { url?: unknown }).url ?? '').trim();
      sources.push(url ? { title: clip(title, 200), url: clip(url, 500) } : { title: clip(title, 200) });
    }
  if (!sources.length) return { ok: false, reason: '没有给出来源。' };
  const doubts = Array.isArray(payload.doubts)
    ? payload.doubts.map((item) => clip(item, 300)).slice(0, 8)
    : [];
  return { ok: true, path, why: clip(why, 2000), sources, doubts };
}

/** 网关会限流（429）也会偶发 5xx：等一会儿重发同一条请求是安全的（还没拿到内容）。 */
async function callModel(
  deps: RouteInferenceDeps,
  body: Record<string, unknown>,
  deadline: number,
): Promise<{ ok: boolean; status: number; payload: any; text: string; retryAfter?: number }> {
  const waits = [3_000, 6_000, 12_000, 20_000, 30_000, 30_000];
  for (let attempt = 0; attempt <= waits.length; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining < 10_000) return { ok: false, status: 0, payload: null, text: '整段推断到时间了。' };
    let result: { ok: boolean; status: number; payload: any; text: string; retryAfter?: number };
    try {
      result = await callModelOnce(deps, body, Math.min(150_000, remaining));
    } catch (error) {
      // 连不上、被掐断也算可重试：这条请求还没拿到任何内容。
      result = { ok: false, status: 0, payload: null, text: String((error as Error)?.message ?? error) };
    }
    if (result.ok || (result.status !== 0 && result.status !== 429 && result.status < 500)) return result;
    if (attempt === waits.length) return result;
    // 网关排队（429）时它会给 retry-after；没有就按阶梯退避，最多等约两分钟。
    const wait = result.retryAfter && Number.isFinite(result.retryAfter)
      ? Math.min(result.retryAfter * 1000, 30_000)
      : waits[attempt];
    if (Date.now() + wait > deadline) return result;
    await new Promise((done) => setTimeout(done, wait));
  }
  return { ok: false, status: 0, payload: null, text: 'retry exhausted' };
}

async function callModelOnce(
  deps: RouteInferenceDeps,
  body: Record<string, unknown>,
  timeoutMs = 180_000,
): Promise<{ ok: boolean; status: number; payload: any; text: string; retryAfter?: number }> {
  const transport = deps.transport ?? fetch;
  // 网关的 base 有两种写法：官方是 .../anthropic（补 /v1/messages），
  // opencodego 是 .../v1（只补 /messages），别拼出 /v1/v1。
  const base = deps.baseUrl.replace(/\/+$/, '');
  const response = await transport(base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': deps.apiKey,
      'anthropic-version': '2023-06-01',
      ...(deps.session ? { 'x-opencode-session': deps.session } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(5_000, timeoutMs)),
  });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }
  const retryAfter = Number(response.headers.get('retry-after'));
  return {
    ok: response.ok,
    status: response.status,
    payload,
    text,
    ...(Number.isFinite(retryAfter) ? { retryAfter } : {}),
  };
}

async function webTool(
  deps: RouteInferenceDeps,
  operation: 'search' | 'fetch',
  input: Record<string, unknown>,
): Promise<string> {
  if (!deps.web) return '这台机器没有配置搜索/读网页的 key，查不了资料；只能靠地形事实和手头信息。';
  const transport = deps.transport ?? fetch;
  const response = await transport(`${deps.web.baseUrl.replace(/\/+$/, '')}/v1/tools/${operation}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + deps.web.apiKey },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await response.text();
  if (!response.ok) return `工具调用失败（上游 ${response.status}）：${clip(text, 300)}`;
  return clip(text, 20_000);
}

/** 地形事实：这一段附近的 OSM 水系、山口、浅滩与山道。查不到就说查不到。 */
async function terrainAround(point: [number, number], radius: number): Promise<string> {
  const query = `[out:json][timeout:60];(
    way(around:${Math.round(radius)},${point[1]},${point[0]})["waterway"];
    way(around:${Math.round(radius)},${point[1]},${point[0]})["natural"="water"];
    node(around:${Math.round(radius)},${point[1]},${point[0]})["mountain_pass"];
    node(around:${Math.round(radius)},${point[1]},${point[0]})["ford"];
    way(around:${Math.round(radius)},${point[1]},${point[0]})["highway"~"^(track|path|bridleway|footway)$"];
  );out tags center 40;`;
  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ReinLab/1.0 (creative route inference)' },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) return `查不到这一带的地形（Overpass ${response.status}）。`;
    const payload = (await response.json()) as {
      elements?: { type: string; tags?: Record<string, string>; lat?: number; lon?: number; center?: { lat: number; lon: number } }[];
    };
    const elements = payload.elements ?? [];
    if (!elements.length) return '这一带 OSM 里没有水系、山口或山道记录：这是「没数据」，不是「没有」。';
    const lines = elements.slice(0, 40).map((item) => {
      const tags = item.tags ?? {};
      const name = tags.name ?? tags.waterway ?? tags.highway ?? tags.natural ?? tags.mountain_pass ?? tags.ford ?? item.type;
      const lat = item.lat ?? item.center?.lat;
      const lon = item.lon ?? item.center?.lon;
      return `${name}${lat !== undefined && lon !== undefined ? ` @ ${lon.toFixed(4)},${lat.toFixed(4)}` : ''}${tags.waterway ? `（水系：${tags.waterway}）` : ''}${tags.highway ? `（道路：${tags.highway}）` : ''}`;
    });
    return clip(`这一带 OSM 记录（前 ${lines.length} 条）：\n` + lines.join('\n'), 20_000);
  } catch (error) {
    return `查地形时出错：${clip((error as Error)?.message ?? error, 200)}`;
  }
}

const TOOLS = [
  toolSchema(
    'web_search',
    '全网搜索。可以一次查多个问题。',
    { queries: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
    ['queries'],
  ),
  toolSchema(
    'web_fetch',
    '读一个网页的正文全文。搜索结果只有摘要，依据要读全文。',
    { url: { type: 'string' }, prompt: { type: 'string' } },
    ['url'],
  ),
  toolSchema(
    'terrain_around',
    '查一点附近的 OSM 水系、山口、浅滩和山道（地理事实，不是历史记录）。',
    { lng: { type: 'number' }, lat: { type: 'number' }, radius_m: { type: 'number' } },
    ['lng', 'lat'],
  ),
  toolSchema(
    'submit_route',
    '交出路线：至少三个经纬度点，加依据和来源。',
    {
      coordinates: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
      why: { type: 'string' },
      sources: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title'] },
      },
      doubts: { type: 'array', items: { type: 'string' } },
    },
    ['coordinates', 'why', 'sources'],
  ),
];

/** 跑一轮：搜索 → 读全文 → 查地形 → 交路线。拿不到合格路线就明确失败。 */
export async function inferRoute(
  deps: RouteInferenceDeps,
  request: RouteInferenceRequest,
): Promise<RouteInferenceResult> {
  const usage = { inputTokens: 0 as number | null, outputTokens: 0 as number | null, webCalls: 0, known: true };
  if (!deps.apiKey) return { ok: false, failure: '本机没配置模型 key，AI 推断路线开不了。', usage: { ...usage, known: false, inputTokens: null, outputTokens: null } };

  const prompt = [
    `从「${request.from.name}」(${request.from.point[0].toFixed(5)},${request.from.point[1].toFixed(5)})`,
    `到「${request.to.name}」(${request.to.point[0].toFixed(5)},${request.to.point[1].toFixed(5)})。`,
    request.mode ? `交通方式：${request.mode.name}，约 ${request.mode.kmPerHour} km/h。` : '交通方式没写。',
    `路网现状：${request.networkState}`,
    request.failure ? `程序算不出来的原因：${request.failure}` : '',
    request.hint ? `作者的要求：${request.hint}` : '',
    '请查资料，画出有依据的一条路。',
  ]
    .filter(Boolean)
    .join('\n');

  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: prompt }];
  let rejection: string | null = null;
  let nudges = 0;
  const deadline = Date.now() + DEADLINE_MS;

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (Date.now() > deadline)
      return { ok: false, failure: '查资料超时（4 分钟），先停下：这一步可能缺资料，也可能一直在找。', usage };
    const body: Record<string, unknown> = {
      model: deps.model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM,
      messages,
      tools: TOOLS,
      ...(rejection ? { tool_choice: { type: 'tool', name: 'submit_route' } } : {}),
    };
    let response: Awaited<ReturnType<typeof callModel>>;
    try {
      response = await callModel(deps, body, deadline);
    } catch (error) {
      return { ok: false, failure: `模型通道不可用：${clip((error as Error)?.message ?? error, 200)}`, usage };
    }
    if (!response.ok) {
      const detail = response.payload?.error?.message ?? response.text.slice(0, 200);
      return {
        ok: false,
        failure:
          response.status === 0
            ? `模型通道没通：${clip(response.text, 200)}`
            : `模型返回 ${response.status}：${clip(detail, 200)}`,
        usage,
      };
    }
    const inputTokens = Number(response.payload?.usage?.input_tokens);
    const outputTokens = Number(response.payload?.usage?.output_tokens);
    if (Number.isFinite(inputTokens)) usage.inputTokens = (usage.inputTokens ?? 0) + inputTokens;
    else usage.inputTokens = null;
    if (Number.isFinite(outputTokens)) usage.outputTokens = (usage.outputTokens ?? 0) + outputTokens;
    else usage.outputTokens = null;

    const content: ContentBlock[] = Array.isArray(response.payload?.content) ? response.payload.content : [];
    const toolUses = content.filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use');
    messages.push({ role: 'assistant', content });
    if (!toolUses.length) {
      const text = content.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text).join('\n');
      if (rejection) return { ok: false, failure: `模型没有交出合格路线：${rejection}`, usage };
      const parsed = extractJson(text);
      const validated = validateSubmittedRoute(parsed, request);
      if (validated.ok) return { ...validated, usage };
      // 只是回了话：再问一次——要么交路线，要么明确放弃。放弃也是一种结果。
      if (nudges < 2) {
        nudges += 1;
        messages.push({
          role: 'user',
          content:
            '要么用 submit_route 交出路线（三个以上点、依据、来源），要么直接说「放弃」并说明缺什么资料。' +
            (text ? `你上一条说的是：${clip(text, 300)}` : ''),
        });
        continue;
      }
      return { ok: false, failure: `模型只回了话，没有交路线${text ? `：${clip(text, 300)}` : ''}`, usage };
    }

    const results: { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }[] = [];
    for (const call of toolUses) {
      if (call.name === 'submit_route') {
        const validated = validateSubmittedRoute(call.input, request);
        if (validated.ok) return { ...validated, usage };
        rejection = validated.reason;
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `这条不算：${validated.reason}。改好再交。`,
          is_error: true,
        });
        continue;
      }
      if (call.name === 'web_search' || call.name === 'web_fetch') {
        if (usage.webCalls >= MAX_WEB_CALLS) {
          results.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: '查资料的次数到上限了（4 次）。用手头已有的信息交路线，或者放弃并说明缺什么。',
          });
          continue;
        }
      }
      if (call.name === 'web_search') {
        usage.webCalls += 1;
        const queries = Array.isArray(call.input.queries)
          ? call.input.queries.map((item) => String(item)).filter(Boolean).slice(0, 4)
          : [];
        // 上游是单 query 接口：一条一条发，合并去重（多问几个也更省时间）。
        const parts = await Promise.all(
          queries.map((query) => webTool(deps, 'search', { query }).catch((error) => `搜索失败：${String(error).slice(0, 200)}`)),
        );
        results.push({ type: 'tool_result', tool_use_id: call.id, content: parts.join('\n\n') });
        continue;
      }
      if (call.name === 'web_fetch') {
        usage.webCalls += 1;
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: await webTool(deps, 'fetch', call.input).catch((error) => `读取失败：${String(error).slice(0, 200)}`),
        });
        continue;
      }
      if (call.name === 'terrain_around') {
        const lng = Number(call.input.lng);
        const lat = Number(call.input.lat);
        const radius = Math.min(60_000, Math.max(500, Number(call.input.radius_m ?? 20_000)));
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: Number.isFinite(lng) && Number.isFinite(lat) ? await terrainAround([lng, lat], radius) : '坐标不对。',
        });
        continue;
      }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: `没有这个工具：${call.name}`, is_error: true });
    }
    messages.push({ role: 'user', content: results });
  }
  return { ok: false, failure: `跑了 ${MAX_STEPS} 步还没交出路线，先停下（可能是资料不够）。`, usage };
}

/** 一次推断大概花多少：已知就按峰值费率估，未知就 null（不记 0）。 */
export function costOfInference(
  deps: RouteInferenceDeps,
  usage: { inputTokens: number | null; outputTokens: number | null; webCalls: number },
): { value: number | null; known: boolean } {
  const fee = deps.web?.feeCny ?? deps.webCallFeeCny ?? 0.005;
  const tokenCost =
    deps.pricing && Number.isInteger(usage.inputTokens) && Number.isInteger(usage.outputTokens)
      ? ((usage.inputTokens as number) * deps.pricing.inputPerMillion +
          (usage.outputTokens as number) * deps.pricing.outputPerMillion) /
        1_000_000
      : null;
  if (tokenCost === null) return { value: null, known: false };
  return { value: Number((tokenCost + usage.webCalls * fee).toFixed(6)), known: true };
}

const routeProposalId = (legId: string) => `pr_${createHash('sha1').update(legId).digest('hex').slice(0, 12)}`;

/** 推断结果写回账本：revision+1、leg 变 inferred、出一条 route 提议，然后重查。 */
export async function storeInference(
  client: pg.PoolClient,
  account: string,
  dossier: string,
  leg: CreativeRouteLeg,
  result: { ok: true; path: GeoJSON.LineString; why: string; sources: { title: string; url?: string }[]; doubts: string[] } | { ok: false; failure: string },
  cost: { value: number | null; known: boolean },
): Promise<{ revision: number; proposal?: Proposal }> {
  const state = await loadWorld(client, account, dossier, { lock: true });
  const document = state.document;
  const revision = state.revision + 1;
  const at = new Date().toISOString();
  const next = { ...document };
  next.inferredRoutes = document.inferredRoutes.filter((item) => item.legId !== leg.id);
  next.routeFailures = document.routeFailures.filter((item) => item.legId !== leg.id);
  let proposal: Proposal | undefined;
  // 这段路作者已经自己画好了：AI 的结果不再挂上去，也不留待确认，
  // 只记一条作废原因（否则页面点确认会把作者的手绘盖掉——1A 遗留 1 的竞态）。
  const alreadyDrawn = document.manualRoutes.some((item) => item.legId === leg.id);
  if (result.ok && alreadyDrawn) {
    const voided: Proposal = {
      id: routeProposalId(leg.id),
      kind: 'route',
      title: '推断路线',
      summary: clip(result.why, 300),
      ops: [{ op: 'route.draw', legId: leg.id, path: result.path }],
      origin: { basis: 'inferred', by: 'route_ai', why: result.why },
      doubts: result.doubts,
      dependsOn: [],
      conflicts: [],
      status: 'rejected',
      resolution: {
        decision: 'rejected',
        reason: '这段路你已经手绘了，这条推断不作数。',
        at,
        by: 'agent',
      },
    };
    proposal = voided;
    next.proposals = [...document.proposals.filter((item) => item.id !== voided.id), voided];
  } else if (result.ok) {
    const proposalId = routeProposalId(leg.id);
    proposal = {
      id: proposalId,
      kind: 'route',
      title: '推断路线',
      summary: clip(result.why, 300),
      ops: [{ op: 'route.draw', legId: leg.id, path: result.path }],
      origin: { basis: 'inferred', by: 'route_ai', why: result.why },
      doubts: result.doubts,
      dependsOn: [],
      conflicts: [],
      status: 'pending',
    };
    next.inferredRoutes = [
      ...next.inferredRoutes,
      { legId: leg.id, proposalId, path: result.path, why: result.why, sources: result.sources },
    ];
    next.proposals = [...document.proposals.filter((item) => item.id !== proposalId), proposal];
  } else {
    next.routeFailures = [...next.routeFailures, { legId: leg.id, failure: result.failure }];
  }
  const spent = next.usage;
  if (cost.known && cost.value !== null && spent.value !== null)
    next.usage = { value: Number((spent.value + cost.value).toFixed(6)), known: true };
  else next.usage = { value: spent.value, known: spent.known && cost.known };

  await client.query(
    'update creative_world set revision=$3, document=$4::jsonb, updated_at=now() where account_id=$1 and dossier_id=$2',
    [account, dossier, revision, JSON.stringify(next)],
  );
  // 契约 §3：creative.leg 的 data 就是那条 RouteLeg（画好、失败、被确认都用它）。
  const legs = await buildLegs(client, { account, dossier, document: next });
  const currentLeg = legs.find((item) => item.id === leg.id) ?? null;
  await appendEvents(client, { account, dossier }, [
    ...(proposal ? [{ type: 'creative.proposal', data: proposal }] : []),
    ...(currentLeg ? [{ type: 'creative.leg', data: currentLeg }] : []),
    { type: 'creative.usage', data: { cost: next.usage } },
  ]);
  const check = runCheck({ document: next, legs, revision, now: at });
  await saveCheck(client, { account, dossier, revision }, check);
  await appendEvents(client, { account, dossier }, [{ type: 'creative.check', data: check }]);
  return { revision, ...(proposal ? { proposal } : {}) };
}

export type InferenceJob = {
  legId: string;
  hint?: string;
};

/**
 * 自动发起推断：leg 算不出来时调它。失败就写 failure（人话），不伪造成功。
 * 花费按 token 记账（未知就记未知），只记不拦。
 */
export async function runInference(
  database: import('../db/database').Database,
  deps: RouteInferenceDeps,
  account: string,
  dossier: string,
  jobs: InferenceJob[],
): Promise<void> {
  if (!jobs.length) return;
  const prepared = await database.withAccount(account, async (client) => {
    const state = await loadWorld(client, account, dossier);
    const legs = await buildLegs(client, { account, dossier, document: state.document });
    const out: { leg: CreativeRouteLeg; from: { name: string; point: [number, number] } | null; to: { name: string; point: [number, number] } | null; mode: { name: string; kmPerHour: number } | null; networkState: string; hint?: string }[] = [];
    for (const job of jobs) {
      const leg = legs.find((item) => item.id === job.legId);
      if (!leg) continue;
      const mode = modeOf(state.document, leg.modeId);
      out.push({
        leg,
        from: placePoint(state.document, leg.fromEventId),
        to: placePoint(state.document, leg.toEventId),
        mode: mode ? { name: mode.name, kmPerHour: mode.kmPerHour } : null,
        networkState:
          state.document.network.state === 'ready'
            ? `已导入 ${state.document.network.sources.map((item) => item.kind).join('、')} 路网，但这两点之间连通不了。`
            : '这个世界观还没有可用的路网。',
        ...(job.hint ? { hint: job.hint } : {}),
      });
    }
    return out;
  });

  for (const item of prepared) {
    if (!item.from || !item.to) continue;
    const result = await inferRoute(deps, {
      account,
      dossier,
      legId: item.leg.id,
      from: item.from,
      to: item.to,
      mode: item.mode,
      failure: item.leg.failure ?? null,
      networkState: item.networkState,
      ...(item.hint ? { hint: item.hint } : {}),
    });
    const cost = costOfInference(deps, result.usage);
    await database.withAccount(account, async (client) => {
      await storeInference(client, account, dossier, item.leg, result, cost);
      await recordUsage(client, {
        account,
        dossier,
        run: null,
        purpose: 'creative_route',
        provider: deps.provider,
        model: deps.model,
        known: result.usage.known && Number.isInteger(result.usage.inputTokens) && Number.isInteger(result.usage.outputTokens),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costCny: cost.known && cost.value !== null ? cost.value.toFixed(6) : null,
      });
      if (cost.known && cost.value !== null) await recordSpend(client, { account, dossier, costCny: cost.value });
    });
  }
}

/** 事件所指地点的坐标（圈选按中心），没有就给 null。 */
function placePoint(
  document: import('./world').CreativeDocument,
  eventId: string,
): { name: string; point: [number, number] } | null {
  const event = document.events.find((item) => item.id === eventId);
  if (!event?.placeId) return null;
  const place = document.entities.find((item) => item.id === event.placeId);
  const geometry = place?.place?.geo;
  if (!geometry) return null;
  if (geometry.type === 'Point') return { name: place?.name ?? '这一处', point: geometry.coordinates as [number, number] };
  if (geometry.type === 'Polygon') {
    const ring = geometry.coordinates[0];
    const sum = ring.reduce((acc, item) => [acc[0] + item[0], acc[1] + item[1]] as [number, number], [0, 0] as [number, number]);
    return { name: place?.name ?? '这一处', point: [sum[0] / ring.length, sum[1] / ring.length] };
  }
  return null;
}

