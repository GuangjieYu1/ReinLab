// MVP-2：出图描述拼装 + 开发占位图是合法 PNG（页面在没 key 时也能走通四格流程）。
import { describe, expect, it } from "vitest";
import { solidPng } from "../src/creative/image/dev-placeholder";
import { promptOf } from "../src/creative/asset-service";

describe("人物形象的出图描述", () => {
  it("按 artStyle + look + note + 写死的视图要求拼", () => {
    const prompt = promptOf({ artStyle: "明清工笔淡彩", look: "青衫，左眉有疤", note: "清瘦", view: "side" });
    expect(prompt).toContain("明清工笔淡彩");
    expect(prompt).toContain("青衫，左眉有疤");
    expect(prompt).toContain("清瘦");
    expect(prompt).toContain("正侧面");
    // 视图要求写死在服务端，不靠模型发挥
    expect(prompt).toContain("白底");
  });
});

describe("开发占位图", () => {
  it("是合法 PNG，宽高写在 IHDR 里", () => {
    const png = solidPng(8, 6, [10, 20, 30]);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(8);
    expect(view.getUint32(20)).toBe(6);
    expect(png.length).toBeGreaterThan(50);
  });
});

describe("出图的价格与错误人话", () => {
  it("按张计价：≤261 万像素 0.3，更大 0.6；参考图第 1 张免费", async () => {
    const { imagePriceOf } = await import("../src/creative/image/ark");
    expect(imagePriceOf({ width: 1024, height: 1536, references: 1 })).toEqual({ value: 0.3, known: true });
    expect(imagePriceOf({ width: 2048, height: 2048, references: 0 })).toEqual({ value: 0.6, known: true });
    expect(imagePriceOf({ width: 1024, height: 1536, references: 2 })).toEqual({ value: 0.32, known: true });
  });

  it("平台错误码翻成人话，不贴原始 JSON", async () => {
    const { humanizeError } = await import("../src/creative/image/ark");
    const raw = '{"error":{"code":"InvalidEndpointOrModel.NotFound","message":"The model ... does not exist"}}';
    const text = humanizeError(404, raw);
    expect(text).toContain("模型不存在");
    expect(text).not.toContain("{");
    expect(humanizeError(400, '{"error":{"code":"SensitiveContentDetected"}}')).toContain("审核");
    expect(humanizeError(429, '{}')).toContain("频繁");
  });
});

describe("路线推断的触发条件", () => {
  it("只改外貌不发路线推断；改事件时间才发", async () => {
    const { routingSignatureOf } = await import("../src/creative/routing");
    const { emptyDocument } = await import("../src/creative/world");
    const document = emptyDocument("测试");
    document.entities = [
      { id: "p1", kind: "person", name: "沈砚", aliases: [], origin: { basis: "author", by: "user" }, status: "accepted", workRefs: [], person: { look: "青衫" } },
      { id: "pl1", kind: "place", name: "城门", aliases: [], origin: { basis: "author", by: "user" }, status: "accepted", workRefs: [], place: { level: "city", parentId: null, geo: { type: "Point", coordinates: [120.6, 31.31] }, geoCertainty: "exact", connects: [] } },
    ];
    document.events = [
      {
        id: "e1", title: "出城", what: "动身", kind: "stay", participants: [{ entityId: "p1", as: "actor" }], placeId: "pl1", travel: null, narrative: "fact",
        origin: { basis: "author", by: "user" }, status: "accepted", gaps: [], workRefs: [],
        start: { t: 100, label: "x", certainty: "exact", calendar: "gregorian", relative: null },
        end: { t: 200, label: "y", certainty: "exact", calendar: "gregorian", relative: null },
      },
    ];
    const before = routingSignatureOf(document);
    const lookOnly = { ...document, entities: document.entities.map((e) => (e.id === "p1" ? { ...e, person: { look: "白衣" } } : e)) };
    expect(routingSignatureOf(lookOnly)).toBe(before);
    const timeChanged = { ...document, events: [{ ...document.events[0], start: { ...document.events[0].start, t: 50 } }] };
    expect(routingSignatureOf(timeChanged)).not.toBe(before);
  });
});

describe("拆解进度（§14.9）", () => {
  it("describeShots 每写完一镜回调一次，带 done/total", async () => {
    const { describeShots } = await import("../src/creative/breakdown-vlm");
    const calls: { done: number; total: number; text: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "镜1：全景；固定；一人。\n镜2：近景；推；两人。" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    try {
      const out = await describeShots(
        { apiKey: "test" },
        { shots: [{ n: 1, startSec: 0, endSec: 2, keyframes: [] }, { n: 2, startSec: 2, endSec: 4, keyframes: [] }], title: "测试" },
        { group: 2, onProgress: (info) => calls.push(info) },
      );
      expect(out.shots).toHaveLength(2);
      expect(calls.map((item) => `${item.done}/${item.total}`)).toEqual(["1/2", "2/2"]);
      expect(calls[0]!.text).toContain("全景");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("下载去重（§14.9 补）", () => {
  it("同一段第二次直接复用，不再调 yt-dlp", async () => {
    const { mkdtemp, writeFile, chmod, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reinlab-dedupe-"));
    const marker = join(dir, "calls.txt");
    const fake = join(dir, "fake-ytdlp.sh");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `echo run >> ${marker}`,
        'prev=""; printed=0; out=""',
        'for a in "$@"; do',
        '  if [ "$a" = "--print" ]; then printed=1; fi',
        '  if [ "$prev" = "-o" ]; then out="$a"; fi',
        '  prev="$a"',
        "done",
        'if [ "$printed" = "1" ]; then',
        '  printf "测试视频\t8\t作者\n"',
        "  exit 0",
        "fi",
        'p=$(echo "$out" | sed "s/%(ext)s/mp4/")',
        'printf "x" > "$p"',
        "exit 0",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const { downloadVideo } = await import("../src/creative/download");
    const deps = { ytDlpPath: fake, folder: join(dir, "素材") };
    const first = await downloadVideo(deps as never, { url: "https://www.bilibili.com/video/BV1test/", from: 0, to: 8, note: "测试" });
    expect(first.reused).toBeUndefined();
    // 还在拆时再下：回「正在拆」，不重复下载
    const busy = await downloadVideo(deps as never, { url: "https://www.bilibili.com/video/BV1test/", from: "0", to: "8", note: "测试" } as never);
    expect(busy.busy).toBe(true);
    // 拆完再下：直接复用
    const metaPath = join(dir, "素材", `${(first.name || "").replace(/\.mp4$/, "")}.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    meta.breakdown.state = "ready";
    await writeFile(metaPath, JSON.stringify(meta));
    const second = await downloadVideo(deps as never, { url: "https://www.bilibili.com/video/BV1test/", from: "0", to: "8", note: "测试" } as never);
    expect(second.reused).toBe(true);
    const calls = (await readFile(marker, "utf8")).trim().split("\n").filter(Boolean).length;
    expect(calls).toBe(2);
  });
});

describe("后台视觉拆解（§14.10）", () => {
  const ffmpeg = "/opt/homebrew/bin/ffmpeg";
  const hasFfmpeg = async () => {
    const { existsSync } = await import("node:fs");
    return existsSync(ffmpeg);
  };
  const stubVision = () => {
    const calls: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      calls.push(body.slice(0, 80));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "镜1：全景；固定；一人站在桥头。" } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = real) };
  };

  it("下载完先返回：切完镜头就返回，视觉模型还没开始调用", async () => {
    if (!(await hasFfmpeg())) return;
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const dir = await mkdtemp(join(tmpdir(), "reinlab-ref-"));
    const video = join(dir, "v.mp4");
    await run(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=12:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
    const base = join(dir, "参考片段__bilibili-BVtest");
    await writeFile(`${base}.json`, JSON.stringify({ url: "https://www.bilibili.com/video/BVtest/", title: "测试" }));
    const vision = stubVision();
    try {
      const { prepareRef, refQueueIdle } = await import("../src/creative/ref-jobs");
      const prepared = await prepareRef(
        { folder: dir, ffmpegPath: ffmpeg, vision: { apiKey: "test" } },
        { videoPath: video, basePath: base, title: "测试", url: "https://www.bilibili.com/video/BVtest/", durationSec: 3 },
      );
      expect(prepared.total).toBeGreaterThan(0);
      expect(vision.calls.length).toBe(0); // 返回时还没调视觉模型
      const meta = JSON.parse(await readFile(`${base}.json`, "utf8"));
      expect(["queued", "analyzing"]).toContain(meta.breakdown.state);
      await refQueueIdle();
      const after = JSON.parse(await readFile(`${base}.json`, "utf8"));
      expect(after.breakdown.state).toBe("ready");
      expect(vision.calls.length).toBeGreaterThan(0);
    } finally {
      vision.restore();
    }
  });

  it("重启后从断点接着拆：已拆好的镜头不重调视觉模型", async () => {
    const { mkdtemp, writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "reinlab-resume-"));
    const base = join(dir, "参考片段__bilibili-BVtest");
    await writeFile(
      `${base}.json`,
      JSON.stringify({
        url: "https://www.bilibili.com/video/BVtest/",
        title: "测试",
        breakdown: {
          state: "analyzing",
          done: 1,
          total: 2,
          shots: [
            { n: 1, startSec: 0, endSec: 1, keyframes: [], text: "已经拆好的第一镜" },
            { n: 2, startSec: 1, endSec: 2, keyframes: [], text: null },
          ],
        },
      }),
    );
    const vision = stubVision();
    try {
      const { runRefJob } = await import("../src/creative/ref-jobs");
      await runRefJob({ folder: dir, ffmpegPath: ffmpeg, vision: { apiKey: "test" } }, base, "测试");
      expect(vision.calls.length).toBe(1); // 只拆第二镜
      const meta = JSON.parse(await readFile(`${base}.json`, "utf8"));
      expect(meta.breakdown.state).toBe("ready");
      expect(meta.breakdown.shots[1].text).toContain("全景");
    } finally {
      vision.restore();
    }
  });
});
