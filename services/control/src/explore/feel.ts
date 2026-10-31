/**
 * 读图 → 想要的感觉（PRD 6.2）。
 *
 * 这件事不能靠模型「记得调 feel.set」：验收里模型把观察写进对话、计划上的感觉卡却是空的。
 * 所以带图开跑前，服务端自己读一次图，把结构化观察写成 feel（actor=agent 的 feel.set），
 * 页面据此立刻出现钉子卡；助手这一轮再补充或修正都行，不会重复。
 */
import type { FeelCard } from "@reinlab/contracts";
import { extractJson } from "./weather-judge";

export type FeelImage = { data: string; mimeType: string; label?: string };

export type FeelReader = (input: {
  images: FeelImage[];
  destination?: string | null;
}) => Promise<{ feel: FeelCard; usage: { inputTokens: number | null; outputTokens: number | null; model: string } }>;

const SYSTEM = [
  "你是摄影指导，任务是看参考照片，提炼这次拍摄「想要的感觉」。",
  "只写照片上真能看到的东西；拿不准的放到 guesses（推测）。",
  "输出只有一个 JSON 对象，不要解释、不要代码块：",
  '{"observations":[{"aspect":"light|tone|composition|pose|other","text":"..."}],"guesses":[{"aspect":"time|focal","text":"..."}]}',
  "observations 3–5 条，每条一句话，写具体的（光从哪来、什么色调、怎么构图、人物姿态）；guesses 0–2 条。",
  "全部用中文。不要提文件名、不要评价照片好坏。",
].join("\n");

const ASPECTS = new Set(["light", "tone", "composition", "pose", "other"]);
const GUESSES = new Set(["time", "focal"]);

/** 把模型输出收成契约形状；不合格的项丢掉，不编。 */
export function normalizeFeel(input: unknown, refIds: string[]): FeelCard {
  const body = (input ?? {}) as { observations?: unknown; guesses?: unknown };
  const list = (value: unknown, allowed: Set<string>) => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const aspect = String((item as { aspect?: unknown }).aspect ?? "");
      const text = String((item as { text?: unknown }).text ?? "").trim();
      if (!text || !allowed.has(aspect)) return [];
      return [{ aspect: aspect as never, text: text.slice(0, 400) }];
    });
  };
  return {
    refIds: [...refIds],
    observations: list(body.observations, ASPECTS).slice(0, 6),
    guesses: list(body.guesses, GUESSES).slice(0, 3),
  };
}

export function createFeelReader(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport?: typeof fetch;
}): FeelReader {
  const transport = options.transport ?? fetch;
  return async (input) => {
    const content: unknown[] = [
      {
        type: "text",
        text: input.destination
          ? `这次要去 ${input.destination} 拍。看下面的参考图，按约定的 JSON 给出想要的感觉。`
          : "看下面的参考图，按约定的 JSON 给出想要的感觉。",
      },
    ];
    input.images.forEach((image, index) => {
      content.push({ type: "text", text: `图 ${index + 1}${image.label ? `（${image.label}）` : ""}：` });
      content.push({
        type: "image",
        source: { type: "base64", media_type: image.mimeType, data: image.data },
      });
    });
    const response = await transport(`${options.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: options.model,
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (!response.ok) throw new Error(`feel reader: provider ${response.status}`);
    const text = Array.isArray(payload.content)
      ? payload.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("")
      : "";
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object")
      throw new Error("feel reader: 没有可解析的结论");
    const refIds: string[] = [];
    return {
      feel: normalizeFeel(parsed, refIds),
      usage: {
        inputTokens: payload.usage?.input_tokens ?? null,
        outputTokens: payload.usage?.output_tokens ?? null,
        model: options.model,
      },
    };
  };
}
