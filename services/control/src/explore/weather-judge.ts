/**
 * 天气变化的判断（06 §5.2「预报与主动检查」）。
 *
 * 每次拿到适用的新预报交模型判断是否显著影响机位；阈值只是参考，不是硬门槛。
 * 模型只输出结构化结论与要改的字段；写入计划仍走「建议 → 用户应用」。
 * 用量由调用方记到这份计划上（用途 weather_judge），未知就记未知，不写 0。
 */
export type WeatherJudgeStop = {
  stopId: string;
  name: string;
  day: string;
  window: { start: string; end: string } | null;
  before: unknown;
  after: unknown;
};

export type WeatherJudgement = {
  material: boolean;
  summary: string;
  changes: { stopId: string; patch: Record<string, unknown>; why: string }[];
};

export type WeatherJudgeUsage = {
  provider: string;
  model: string;
  known: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

export type WeatherJudge = (input: {
  timezone: string;
  destination: string;
  revision: number;
  stops: WeatherJudgeStop[];
}) => Promise<{ judgement: WeatherJudgement; usage: WeatherJudgeUsage }>;

/** 可以改的字段：只让模型动拍摄安排，不动服务端字段和别人的计划。 */
export const JUDGE_PATCHABLE = new Set(["window", "day", "facing", "focal", "reason", "fallback"]);

const SYSTEM = [
  "你是这位摄影师的旅拍助手，判断新的预报会不会真的影响这次拍摄。",
  "只输出一个 JSON 对象，不要别的话：",
  '{"material":true|false,"summary":"一句话说清影响","changes":[{"stopId":"停留点 id","patch":{"要改的字段":值},"why":"为什么"}]}',
  "能改的字段只有 window（{start,end} 带偏移的 ISO）、day、facing、focal、reason、fallback。",
  "没有明显影响就 material:false、changes:[]，不要为了体现存在感而报警。",
  "只用给你的数据里的天气，不编造没有的数值；拿不准就不改。",
].join("\n");

const THRESHOLD_HINT =
  "参考阈值（不是硬门槛）：降水概率跨过 60% 且降水量达 0.5 mm/h；依赖直射光时云量增至少 30 个百分点且达 70%；阵风跨过 10 m/s。";

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** 从一段文本里取出第一个完整 JSON 对象（模型偶尔会带解释或代码围栏）。 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const direct = (() => {
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  })();
  if (direct !== undefined) return direct;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** 把模型输出收成能用的判断；不合法就当"没影响"，不硬凑建议。 */
export function normalizeJudgement(raw: unknown, allowedStopIds: Set<string>): WeatherJudgement {
  const value = raw as { material?: unknown; summary?: unknown; changes?: unknown };
  const changes = Array.isArray(value?.changes)
    ? value.changes
        .map((entry) => {
          const change = entry as { stopId?: unknown; patch?: unknown; why?: unknown };
          const stopId = typeof change?.stopId === "string" ? change.stopId : "";
          if (!allowedStopIds.has(stopId)) return null;
          const patchInput =
            change?.patch && typeof change.patch === "object" && !Array.isArray(change.patch)
              ? (change.patch as Record<string, unknown>)
              : null;
          if (!patchInput) return null;
          const patch: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(patchInput))
            if (JUDGE_PATCHABLE.has(key)) patch[key] = value;
          if (!Object.keys(patch).length) return null;
          return {
            stopId,
            patch,
            why: typeof change?.why === "string" ? change.why.slice(0, 200) : "",
          };
        })
        .filter((entry): entry is { stopId: string; patch: Record<string, unknown>; why: string } => Boolean(entry))
        .slice(0, 8)
    : [];
  const material = value?.material === true && changes.length > 0;
  return {
    material,
    summary:
      typeof value?.summary === "string" && value.summary.trim()
        ? value.summary.trim().slice(0, 300)
        : material
          ? "天气有变化，建议调整"
          : "天气变化不影响这次安排",
    changes: material ? changes : [],
  };
}

/** 真实模型通道：和内核同一条 Anthropic 兼容 Messages 入口，只是宿主自己带着 key 调。 */
export function createWeatherJudge(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider?: string;
  maxTokens?: number;
  timeoutMs?: number;
  transport?: (request: Request) => Promise<Response>;
}): WeatherJudge {
  const forward = options.transport ?? ((request: Request) => fetch(request, { redirect: "error" }));
  return async (input) => {
    const target = new URL(options.baseUrl.replace(/\/+$/, "") + "/v1/messages");
    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 900,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            destination: input.destination,
            timezone: input.timezone,
            revision: input.revision,
            hint: THRESHOLD_HINT,
            stops: input.stops,
          }),
        },
      ],
    };
    const response = await forward(
      new Request(target, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": options.apiKey,
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      }),
    );
    const text = await response.text();
    const payload = (() => {
      try {
        return JSON.parse(text) as any;
      } catch {
        return undefined;
      }
    })();
    const usage = payload?.usage;
    const inputTokens = count(usage?.input_tokens);
    const outputTokens = count(usage?.output_tokens);
    const known = inputTokens !== null && outputTokens !== null;
    const normalizedUsage: WeatherJudgeUsage = {
      provider: options.provider ?? "deepseek-official",
      model: options.model,
      known,
      inputTokens,
      outputTokens,
      cacheReadTokens: count(usage?.cache_read_input_tokens),
      cacheWriteTokens: count(usage?.cache_creation_input_tokens),
    };
    if (!response.ok) {
      const detail = String(
        payload?.error?.message ?? payload?.message ?? text.slice(0, 200),
      ).slice(0, 200);
      throw Object.assign(new Error(`天气判断调用失败：${response.status}${detail ? "：" + detail : ""}`), {
        usage: normalizedUsage,
      });
    }
    const content = Array.isArray(payload?.content)
      ? payload.content.filter((block: any) => block?.type === "text").map((block: any) => block.text).join("")
      : "";
    return {
      judgement: normalizeJudgement(extractJson(content), new Set(input.stops.map((stop) => stop.stopId))),
      usage: normalizedUsage,
    };
  };
}
