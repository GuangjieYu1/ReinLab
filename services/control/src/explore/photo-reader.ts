/**
 * 看片（design/prd/09-explore-v2.md §6.1）。
 *
 * 助手「看」一张照片这件事由服务端做一次真调用：只把派生图（预览 / 局部裁切）发过去，
 * 让它说能看见的东西（对焦、曝光、有没有明显问题），拿不准就标 uncertain。
 * 用量按真实 token 记账；token 不可得就记未知，不记 0。
 */
import { extractJson } from "./weather-judge";

export type PhotoObservation = {
  photoId: string;
  focus: "sharp" | "soft" | "unknown";
  exposure: "ok" | "dark" | "bright";
  note: string;
  /** 这张看不清（太小、太暗、拿不准）——页面据此说"没细看"。 */
  uncertain: boolean;
};

export type PhotoReader = (input: {
  images: { photoId: string; data: string; mimeType: string; label?: string }[];
  ask?: string;
}) => Promise<{
  observations: PhotoObservation[];
  summary: string;
  usage: { inputTokens: number | null; outputTokens: number | null; model: string };
}>;

const SYSTEM = [
  "你是摄影指导，正在帮用户挑片。看下面的照片，只说照片上真能看见的东西。",
  "输出只有一个 JSON 对象，不要解释、不要代码块：",
  '{"photos":[{"photoId":"给定的id","focus":"sharp|soft|unknown","exposure":"ok|dark|bright","note":"一句话，具体指出问题或优点","uncertain":false}],"summary":"一句话"}',
  "note 用中文，不评价美丑，不提文件名。看不清、太小、拿不准时 focus/exposure 给 unknown、uncertain 给 true，别硬猜。",
  "不要推荐或淘汰任何照片：标不标记由调用方决定。",
].join("\n");

const FOCUS = new Set(["sharp", "soft", "unknown"]);
const EXPOSURE = new Set(["ok", "dark", "bright"]);

export function normalizeObservations(input: unknown, wanted: string[]): PhotoObservation[] {
  const photos = (input as { photos?: unknown })?.photos;
  if (!Array.isArray(photos)) return [];
  const allowed = new Set(wanted);
  return photos.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const photoId = String(row.photoId ?? "");
    if (!allowed.has(photoId)) return [];
    const focus = String(row.focus ?? "unknown");
    const exposure = String(row.exposure ?? "ok");
    return [
      {
        photoId,
        focus: (FOCUS.has(focus) ? focus : "unknown") as PhotoObservation["focus"],
        exposure: (EXPOSURE.has(exposure) ? exposure : "ok") as PhotoObservation["exposure"],
        note: String(row.note ?? "").trim().slice(0, 300),
        uncertain: row.uncertain === true,
      },
    ];
  });
}

export function createPhotoReader(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  transport?: typeof fetch;
}): PhotoReader {
  const transport = options.transport ?? fetch;
  return async (input) => {
    const content: unknown[] = [
      {
        type: "text",
        text:
          (input.ask ? `${input.ask}\n\n` : "") +
          `看下面 ${input.images.length} 张照片，按约定的 JSON 逐个给结论（photoId 必须原样照抄）。`,
      },
    ];
    input.images.forEach((image, index) => {
      content.push({ type: "text", text: `照片 ${index + 1} · id=${image.photoId}${image.label ? `（${image.label}）` : ""}：` });
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
        max_tokens: 1600,
        system: SYSTEM,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      content?: { type?: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (!response.ok) throw new Error(`photo reader: provider ${response.status}`);
    const text = Array.isArray(payload.content)
      ? payload.content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("")
      : "";
    const parsed = extractJson(text);
    const observations = normalizeObservations(parsed, input.images.map((image) => image.photoId));
    if (!parsed || typeof parsed !== "object")
      throw new Error("photo reader: 没有可解析的结论");
    return {
      observations,
      summary: String((parsed as { summary?: unknown }).summary ?? "").slice(0, 400),
      usage: {
        inputTokens: payload.usage?.input_tokens ?? null,
        outputTokens: payload.usage?.output_tokens ?? null,
        model: options.model,
      },
    };
  };
}
