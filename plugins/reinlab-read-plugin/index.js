// ReinLab deep-reading tools for the headless DeepSeek Harness kernel.
//
// The plugin owns the reading behaviour only: it forwards each tool call to the
// control plane over HTTP with the run token, and waits there when the action
// needs the user's one-shot approval. It deliberately exposes no generic file
// writer, shell or subagent: those base tools are disabled by the profile patch.
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "reinlab-read";
export const inject = ["tools"];

const poll = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(config, key) {
  const value = config && config[key];
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`reinlab-read-plugin: missing config ${key}`);
  return value;
}

/** Read the run token from the run-scoped file written by the control plane. */
async function readToken(config) {
  if (typeof config.token === "string" && config.token.trim() !== "")
    return config.token.trim();
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(required(config, "tokenFile"), "utf8");
  const token = text.trim();
  if (!token) throw new Error("reinlab-read-plugin: empty run token");
  return token;
}

export function createClient(config, fetchImpl = fetch) {
  const controlUrl = required(config, "controlUrl").replace(/\/+$/, "");
  return async function call(server, tool, args, extra = {}) {
    const token = await readToken(config);
    // 工具调用必须有有限时限：控制面万一卡住，不能把这一轮无限挂在这里。
    const response = await fetchImpl(`${controlUrl}/kernel/tool`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify({ server, tool, args, ...extra }),
      signal: AbortSignal.timeout(Number(config.toolTimeoutMs ?? 120_000)),
    }).catch((error) => ({
      ok: false,
      status: 0,
      json: async () => ({
        code: error?.name === "TimeoutError" ? "KERNEL_TOOL_TIMEOUT" : "KERNEL_TOOL_UNREACHABLE",
        message: "这次工具调用没有拿到控制面的响应，请重试或换一种做法。",
      }),
    }));
    const body = await response.json().catch(() => ({}));
    if (response.status === 409 && body.state === "pending")
      // pending 一并带回去：对话里要按它渲染计划修改卡，而不是按消息文字猜。
      return { pending: true, approvalId: body.approvalId, pendingChange: body.pending ?? null };
    if (!response.ok)
      // 错误码和原因原样交给模型：换源、改参数还是问用户，由它自己决定。
      return {
        pending: false,
        error: {
          code: String(body.code ?? body.error ?? `KERNEL_TOOL_HTTP_${response.status}`),
          message: String(body.message ?? body.error ?? `工具返回 ${response.status}`),
          status: response.status,
        },
      };
    return { pending: false, result: body.result };
  };
}

/** 需要用户决定时，把请求交给控制面，然后如实告诉模型「在等用户」。 */
const waiting = (what, approvalId) => ({
  status: "waiting_for_user",
  approvalId,
  message:
    `已把「${what}」的请求交给用户（审批 ${approvalId}），等用户处理后会从这一段继续。` +
    "这不代表已批准，也不代表失败：不要反复重试同一个请求。",
});

const text = (value) => [{ type: "text", text: JSON.stringify(value) }];

const output = { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) };
/** 工具失败就是返回值里的一段数据，不结束这一轮。 */
const unwrap = (outcome) => (outcome.error ? { error: outcome.error } : outcome.result);

export function apply(ctx, config) {
  const call = createClient(config, (config && config.fetch) || fetch);
  const register = (definition) => ctx.tools.register(definition);
  // 两个阶段给同一套能力：用什么、先用哪个、要不要再问用户，都由模型自己决定。

  register(
    defineTool({
      name: "papers_search",
      description:
        "按关键词检索真实论文。可用来源：arxiv（有全文）、openalex（元数据+开放全文）、crossref（书目元数据+DOI）。不指定来源时三家一起查；每家成功与否和失败原因都会在 sources 里返回。",
      parameters: {
        query: { type: "string", required: true, description: "检索词。" },
        source: { type: "string", description: "arxiv | openalex | crossref | auto（默认全部）。" },
        limit: { type: "integer", description: "最多返回几条，1-20。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("papers", "search", args));
      },
    }),
  );

  // 澄清阶段还没有选定的论文，本来就不该下载：这个工具在那一阶段不存在。
  if (config.mode === "read")
    register(
      defineTool({
        name: "papers_fetch",
        description:
          "把一篇论文下载进当前档案并登记资产。paperId 支持 arxiv:、W（OpenAlex）、doi:。下载要用户批准一次；同一篇重复调用返回已有资产。",
        parameters: {
          paperId: { type: "string", required: true, description: "arxiv:2302.04761v1 / W123456 / doi:10.1000/xyz。" },
        },
        output,
        // Waiting for the user's decision is not a slow tool: keep the turn open.
        timeoutMs: 660_000,
      async execute(args) {
        // 已批准（续接那一轮）再调到这里时，控制面会直接执行并返回结果；
        // 还没批准就返回「在等用户」，这一轮到此结束，不占着执行段轮询。
        const first = await call("papers", "fetch", args);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("下载论文全文", first.approvalId);
      },
      }),
    );


  if (config.mode === "read")
    register(
      defineTool({
        name: "papers_register",
        description:
          "把当前档案工作区里已经有的 PDF 登记为本档案论文，入档需要用户批准一次。怎么拿到文件的不管；账户和档案由会话决定，不用填。",
        parameters: {
          path: { type: "string", required: true, description: "工作区里的 PDF 路径，绝对路径或相对工作区根。" },
          title: { type: "string", required: true, description: "论文标题；不确定就照实问用户，不要编。" },
          authors: { type: "string", description: "已知作者，可留空。" },
          doi: { type: "string", description: "已知 DOI 或 arXiv 号，没有就留空。" },
          source: { type: "string", description: "已知来源 URL，没有就留空。" },
        },
        output,
        timeoutMs: 660_000,
        async execute(args) {
          const first = await call("papers", "register", args);
          if (first.error) return first.error;
          if (!first.pending) return first.result;
          return waiting("这篇论文正式入档", first.approvalId);
        },
    }),
  );

  register(
    defineTool({
      name: "papers_pages",
      description: "读取已下载论文的具体页码，返回该页原文。",
      parameters: {
        assetId: { type: "string", required: true, description: "档案里的论文资产 id。" },
        pages: { type: "array", required: true, items: { type: "integer" }, description: "页码，从 1 开始，最多 20 页。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("papers", "pages", args));
      },
    }),
  );

  register(
    defineTool({
      name: "card_layer",
      description: "保存一层讲解卡。卡片里的说法都要有实际读到的页码依据。",
      parameters: {
        card: {
          type: "object",
          additionalProperties: true,
          required: true,
          description:
            "{\"paperId\":\"资产id\",\"no\":\"1\",\"title\":\"一句话\",\"en\":\"One-liner\",\"body\":[{\"text\":\"…\",\"refs\":[{\"paperId\":\"资产id\",\"page\":2,\"quote\":\"原文片段\"}]}]}",
        },
      },
      output,
      async execute(args) {
        return unwrap(await call("cards", "card.layer", { card: args.card ?? args }));
      },
    }),
  );

  register(
    defineTool({
      name: "card_finding",
      description: "保存一条发现卡，带上依据页码。",
      parameters: {
        text: { type: "string", required: true, description: "发现内容。" },
        evidence: { type: "array", required: true, items: { type: "object", additionalProperties: true }, description: "paperId/page/quote 依据。" },
        confidence: { type: "string", description: "low | mid | high。" },
        status: { type: "string", description: "hypothesis | supported | refuted。" },
      },
      output,
      async execute(args) {
        return unwrap(await call("cards", "card.finding", { card: args.card ?? args }));
      },
    }),
  );

  // 探索台（EXPL）：计划与画布。和页面调同一组服务函数，账户和档案由会话决定。
  if (config.mode === "explore") {
    register(
      defineTool({
        name: "explore_get",
        description:
          "读当前这份旅拍计划：计划正文、停留点、步行路线、画布草图、最后视野。改计划之前先看一眼当前状态。",
        parameters: {},
        output,
        async execute() {
          return unwrap(await call("explore", "get", {}));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_ops",
        description:
          "改当前这份旅拍计划。一次调用是一批，要么全生效要么都不生效。会改动已确认行程的动作需要用户同意：服务端会自动核对用户这句话——明确要求了就直接生效，没说清就出一张计划修改卡并返回 pending，这时别说已经改好。" +
          "注意：一次只做用户这句话真的要求的那几步。用户说「留下这三个点」不等于「确认整份计划」，别顺手把别的候选也转正或删除。" +
          "每个 op 的确切形状（只能用这些名字，别的名字会被拒）：\n" +
          'stop.add {op:"stop.add", stop:{kind:"spot"|"area"|"waypoint", name, geometry:{type:"Point",coordinates:[经度,纬度]} 或 {type:"Polygon",coordinates:[[[经度,纬度],…]]}, day:"YYYY-MM-DD", window:{start:"2026-11-15T07:00:00+09:00",end:"…"} 或 null, reason?, facing?, focal?:[85], refs?:[], state?:"candidate"|"confirmed", detail?:{composition?:string, guidance?:string[], outfit?:{palette?:string[],notes?:string}, rules?:{text:string,source?:{name:string,url?:string}}[], fallback?:string}}}\n' +
          'stop.update {op:"stop.update", id, patch:{name?,geometry?,day?,window?,reason?,facing?,focal?,refs?,detail?}}\n' +
          'stop.remove {op:"stop.remove", id}\n' +
          'stop.confirm {op:"stop.confirm", ids:["停留点 id"]}\n' +
          'plan.set {op:"plan.set", patch:{destination?:{name, center:[经度,纬度], timezone:"Asia/Tokyo"}, days?:["2026-11-15"], kinds?:["portrait"|"landscape"|"travel"|"street"]}}（拍法用英文枚举，不是「人像」）\n' +
          'plan.confirm {op:"plan.confirm"}  plan.finish {op:"plan.finish"}  plan.cancel {op:"plan.cancel"}\n' +
          'plan.select {op:"plan.select", people?:[], gear?:[], refresh?:true}\n' +
          'feel.set {op:"feel.set", feel:{refIds:[], observations:[{aspect:"light"|"tone"|"composition"|"pose"|"other", text}], guesses:[{aspect:"time"|"focal", text}]}}\n' +
          'canvas.add {op:"canvas.add", object:{kind:"marker"|"arrow"|"line"|"freehand"|"area"|"note", geometry:{…GeoJSON}, text?, links?:{stopId?,refId?,place?}}}\n' +
          'canvas.update {op:"canvas.update", id, patch:{geometry?,text?,links?}}  canvas.remove {op:"canvas.remove", id}  canvas.undo {op:"canvas.undo"}\n' +
          'view.save {op:"view.save", viewport:{center:[经度,纬度],zoom,bearing,pitch}, basemap:"vector"|"satellite"}\n' +
          "坐标一律 WGS84 [经度, 纬度]；时间是带偏移的 ISO；日期是当地 YYYY-MM-DD；新建停留点/草图的 id 由服务端分配，不要自己编。",
        parameters: {
          ops: {
            type: "array",
            required: true,
            items: { type: "object", additionalProperties: true },
            description:
              '动作数组，例如 [{"op":"stop.add","stop":{"kind":"spot","name":"白川旁的石桥","geometry":{"type":"Point","coordinates":[135.78,35.01]},"day":"2026-11-15","window":{"start":"2026-11-15T07:10:00+09:00","end":"2026-11-15T07:50:00+09:00"},"reason":"清晨逆光"}}]。',
          },
          baseRevision: { type: "number", description: "可选：你读到的修订号，带上可以避免覆盖别人的修改。" },
        },
        output,
        async execute(args) {
          const first = await call("explore", "ops", args);
          if (first.error) return first.error;
          if (!first.pending) return first.result;
          return { ...waiting("这批计划修改", first.approvalId), pending: first.pendingChange };
        },
      }),
    );

    register(
      defineTool({
        name: "explore_pending",
        description:
          "读这份档案里正等着用户点头的事（天气建议、计划修改卡等）：每条带标题、用途、是哪个修订、改了什么。用户问「有什么要处理的」就用它；要不要应用由用户决定，你只负责说清楚，别替他点。",
        parameters: {},
        output,
        async execute() {
          return unwrap(await call("explore", "pending", {}));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_light",
        description:
          "算某个停留点的山体遮挡：取周围真实高程（Copernicus GLO-90，约 90 米）估地平线曲线和「山后见光」时段，并写回这份计划（页面与计划书直接读）。取不到高程就返回未知和原因——别默认没遮挡，也别把天文日出当成能拍到光。不传 stopId 就依次算前几个停留点。",
        parameters: { stopId: { type: "string", description: "只算这个停留点。" } },
        output,
        async execute(args) {
          return unwrap(await call("explore", "light", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_places",
        description:
          "查真实地点（页面搜索框同一条路）：国内走高德、海外走 openrouteservice，返回名称、地址、坐标和来源。查不到或没配服务会照实说明，不要自己编地名或坐标。",
        parameters: {
          q: { type: "string", required: true, description: "地点名或关键词。" },
          near: { type: "array", items: { type: "number" }, description: "可选：附近 [经度, 纬度]，用来排序和挑服务商。" },
          provider: { type: "string", description: "可选：amap | ors（不说就按目的地时区挑）。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "places", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_route",
        description:
          "两个停留点（或两组坐标）之间的真实步行路线与用时。给 fromStopId/toStopId 用计划里的点；也可以直接给 from/to 的 [经度, 纬度]。拿不到就返回 unavailable 和原因，别拿直线距离当步行路线。",
        parameters: {
          fromStopId: { type: "string", description: "起点停留点 id。" },
          toStopId: { type: "string", description: "终点停留点 id。" },
          from: { type: "array", items: { type: "number" }, description: "起点 [经度, 纬度]（不用停留点时）。" },
          to: { type: "array", items: { type: "number" }, description: "终点 [经度, 纬度]。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "route", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_profiles",
        description:
          "读这个账户里的模特和器材（只读你确认过的内容）。给用户推荐时只用这里已有的机身和镜头，不要假设他有什么。",
        parameters: { type: { type: "string", description: "model | gear；不传就都给。" } },
        output,
        async execute(args) {
          return unwrap(await call("explore", "profiles", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_profile_write",
        description:
          "新增/修改/删除账户里的模特或器材。只能写用户自己说过的内容：他的原话里要同时点到「这条资料」和「记住/加上/改成/删掉」。没得到明确要求时服务端会退回 needs_user_confirmation——那就先在对话里问一句，别自己编。",
        parameters: {
          action: { type: "string", description: "add | update | delete。" },
          type: { type: "string", description: "model | gear。" },
          id: { type: "string", description: "改或删的时候用；也可以用 name 对上。" },
          name: { type: "string", description: "称呼或器材名，要跟用户说的一致。" },
          height: { type: "number", description: "模特身高（cm），用户说过才填。" },
          style: { type: "string" },
          experience: { type: "string" },
          wardrobe: { type: "string" },
          notes: { type: "string" },
          kind: { type: "string", description: "器材：body | lens。" },
          focal: { type: "array", items: { type: "number" }, description: "镜头焦段范围，比如 [85, 85]。" },
          aperture: { type: "number", description: "最大光圈，比如 1.8。" },
        },
        output,
        async execute(args) {
          const out = await call("explore", "profile_write", args);
          if (out.error) return out.error;
          return out.result;
        },
      }),
    );

    register(
      defineTool({
        name: "explore_ref_add",
        description:
          "把网上找到的参考图收进这份档案：服务端抄一份副本（页面和计划书都能稳定显示），同时保留原网页、作者、平台和出处时间。可以直接给图片地址，也可以给带图的网页（会读页面的分享图）。拿不到图时只记来源并告诉你原因，这时照实跟用户说「只有链接」，不要拿别的图顶替。kind：same-spot = 该机位实拍，style = 风格参考，别把风格参考说成实拍。",
        parameters: {
          url: { type: "string", required: true, description: "图片地址或带图的网页地址（http/https）。" },
          kind: { type: "string", description: "same-spot | style。" },
          stopId: { type: "string", description: "关联到哪个停留点（可选）。" },
          author: { type: "string", description: "作者，知道才填。" },
          platform: { type: "string", description: "平台，比如 小红书 / Instagram / Flickr。" },
          takenAt: { type: "string", description: "拍摄或发布的时间，知道才填。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "ref_add", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_book",
        description:
          "生成两版计划书之一：brief 是一页精简版，full 是总览加每个停留点一页。用户说「出一份计划书 / 打印一份」就用它，生成后自动入档，不用再问要不要挂载。只用同一计划修订的地图快照：素材不齐会返回 needs_map_snapshot 并请用户打开计划页面点一次生成，这时不要假称已经生成。",
        parameters: { variant: { type: "string", description: "brief | full。" } },
        output,
        async execute(args) {
          return unwrap(await call("explore", "book", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_refs",
        description:
          "读这份档案里的参考图（用户上传的、以及从网上入档的）。image 为 null 表示没拿到图，只有来源，这时照实说「只有链接」，不要拿别的图顶替。",
        parameters: {},
        output,
        async execute() {
          return unwrap(await call("explore", "refs", {}));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_usage",
        description: "看这份计划已经用掉的模型调用与 token（按用途、按模型、Search/Fetch 次数）。未知的用量是未知，不是 0。",
        parameters: {},
        output,
        async execute() {
          return unwrap(await call("explore", "usage", {}));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_weather",
        description:
          "读这份计划里停留点的逐时天气（Open-Meteo，真实预报）：云量 %、降水概率 %、降水量 mm/h、风速与阵风 m/s、温度 °C，按那个点自己的位置和当地时间给，跨午夜取完整时段。返回里带取数时间、来源，以及 state（ok / out_of_range / failed）；out_of_range 说明那一天还没进预报范围，约从 fromDate 起能查，这时不要编数据。",
        parameters: {
          stopId: { type: "string", description: "只看某个停留点；不传就看全部已确认停留点（还没有停留点时按目的地给）。" },
          refresh: { type: "boolean", description: "true 时不复用 20 分钟内的旧快照，重新取一次。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "weather", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_sun",
        description:
          "算真实太阳时刻与方向：日出日落、正午、金色时刻（太阳高度 −4°～6°）、蓝调（−6°～−4°），停留点拍摄时段两端的太阳方位（真北 0° 顺时针）与高度角；有地形数据时连同每个点的山后见光时段一起给。方位和时刻按停留点位置与拍摄地点时区。",
        parameters: {
          stopId: { type: "string", description: "只算某个停留点；不传就算全部停留点（没有停留点时按目的地算）。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "sun", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_view",
        description:
          "把页面地图移到某个位置和缩放（用户手动拖过地图就会停止跟随，不会抢回来）。center 是 WGS84 [经度, 纬度]。",
        parameters: {
          viewport: {
            type: "object",
            required: true,
            additionalProperties: true,
            description: '{"center":[135.78,35.01],"zoom":14,"bearing":0,"pitch":0}',
          },
          basemap: { type: "string", description: "vector | satellite。" },
        },
        output,
        async execute(args) {
          return unwrap(await call("explore", "view", args));
        },
      }),
    );

    register(
      defineTool({
        name: "explore_undo",
        description: "撤回你自己最近一笔画布改动（只动画布，不动正式停留点和路线）。",
        parameters: {},
        output,
        async execute() {
          return unwrap(await call("explore", "undo", {}));
        },
      }),
    );
  }

  // 第 7 节：档案工具。七个台的最小侧边会话都靠这组工具；和页面调同一组服务函数。
  const dossierTool = (name, description, parameters) =>
    register(
      defineTool({
        name,
        description,
        parameters,
        output,
        async execute(args) {
          const out = await call("dossiers", name.replace(/^dossier_/, "").replace(/_/g, "_"), args);
          return out.error ?? out.result;
        },
      }),
    );

  dossierTool("dossier_list", "列出/搜索这个账户的档案。", {
    bench: { type: "string", description: "只看某个台：research/curriculum/…；不传就是全部。" },
    q: { type: "string", description: "按标题或目标搜索。" },
    view: { type: "string", description: "active | archived。" },
  });
  dossierTool("dossier_get", "读取一份档案的概况、最近运行和成果。", {
    dossierId: { type: "string", description: "档案 id；不传就是当前这份。" },
  });
  dossierTool("dossier_create", "新建一份档案。", {
    bench: { type: "string", required: true, description: "工作台 id。" },
    kind: { type: "string", description: "reading | topic | workspace | learning。" },
    title: { type: "string", description: "用户明确给了标题才传。" },
    intent: { type: "string", description: "用户想做什么。" },
  });
  dossierTool("dossier_update", "改档案标题、目标或标记完成。", {
    dossierId: { type: "string" },
    baseVersion: { type: "number", description: "必填：读到的最新版本号。" },
    title: { type: "string" },
    intent: { type: "string" },
    lifecycle: { type: "string", description: "active | completed。" },
  });
  dossierTool("dossier_archive", "归档一份档案；有活跃工作时会返回确认卡。", { dossierId: { type: "string" } });
  dossierTool("dossier_unarchive", "取消归档。", { dossierId: { type: "string" } });
  dossierTool("dossier_delete", "请求删除一份档案，只返回确认卡，不直接删。", { dossierId: { type: "string" } });
  dossierTool("dossier_attach_course", "把一门已有课程加进学习档案。", {
    dossierId: { type: "string" },
    courseId: { type: "string", required: true },
    title: { type: "string" },
  });
  dossierTool("dossier_detach", "把一项成果从档案里解除关联（不删原件）。", {
    dossierId: { type: "string" },
    artifactId: { type: "string", required: true },
  });

  // 课程台最小能力：把一份简短学习计划交给用户确认并同时入档。
  // 计划确认就是入档批准，不额外再要一次。
  register(
    defineTool({
      name: "course_plan",
      description:
        "提交一份简短学习计划（目标 + 少量阶段）给用户确认；用户同意后这份计划即写入课程档案，并回报已入档。计划确认与入档是同一次批准。",
      parameters: {
        goal: { type: "string", required: true, description: "这次要达成的学习目标，一两句话。" },
        steps: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "计划阶段，每项含 title 与可选 detail；保持简短。",
        },
        note: { type: "string", description: "可选的补充说明。" },
      },
      output,
      async execute(args) {
        const first = await call("courses", "plan", args);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("这份学习计划并入档", first.approvalId);
      },
    }),
  );

  register(
    defineTool({
      name: "clarify_question",
      description:
        "在这一段对话里向用户提问；带 candidates 时用户会看到可选论文卡。不要替用户选。",
      parameters: {
        question: { type: "string", required: true, description: "要问的问题。" },
        kind: { type: "string", description: "text | paper_pick。" },
        candidates: { type: "array", items: { type: "object", additionalProperties: true }, description: "真实候选论文。" },
      },
      output,
      timeoutMs: 660_000,
      async execute(args) {
        const askArgs =
          Array.isArray(args.candidates) && args.candidates.length > 0
            ? { ...args, kind: "paper_pick" }
            : args;
        // 用户已经回答过（续接那一轮）会直接拿到答案；还没回答就交出去等待。
        const first = await call("cards", "clarify.question", askArgs);
        if (first.error) return first.error;
        if (!first.pending) return first.result;
        return waiting("需要你确认的信息", first.approvalId);
      },
    }),
  );
}
