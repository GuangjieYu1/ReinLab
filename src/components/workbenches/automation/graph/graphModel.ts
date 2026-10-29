// 节点图（照 ComfyUI 的节点体系，换莱茵生命的皮）+ 工作区（照 ComfyUI-Workspace-Manager：文件夹 / 标签 / 版本 / 画廊 / 模型管理）。
// 节点图可以「发布为工具」，例程用 @工具名 调用：例程管什么时候跑、要不要问你，节点图管具体怎么生成。全部为本地模拟。

export type SType = 'MODEL' | 'CLIP' | 'VAE' | 'CONDITIONING' | 'LATENT' | 'IMAGE' | 'MASK' | 'CONTROL_NET' | 'UPSCALE_MODEL' | 'TEXT' | 'DOC';
/** 插槽配色沿用 ComfyUI 的类型区分，压低了饱和度；橙色留给「正在运行 / 等你」。 */
export const TYPE_COLOR: Record<SType, string> = {
  MODEL: '#9b8fc4', CLIP: '#c9a92a', VAE: '#cc6a5e', CONDITIONING: '#b8956c', LATENT: '#c27fba', IMAGE: '#5b8fbf',
  MASK: '#6a9f6a', CONTROL_NET: '#3c9e83', UPSCALE_MODEL: '#8a8f99', TEXT: '#3a3837', DOC: '#9a9792',
};
export type Cat = '加载器' | '条件' | '采样' | '潜空间' | '图像' | 'ControlNet' | '放大' | '通用';
export const CAT_CODE: Record<Cat, string> = { 加载器: 'LOADER', 条件: 'COND', 采样: 'SAMPLING', 潜空间: 'LATENT', 图像: 'IMAGE', ControlNet: 'CNET', 放大: 'UPSCALE', 通用: 'RHINE' };
export type WKind = 'combo' | 'int' | 'float' | 'text' | 'string' | 'seed';
export type WDef = { name: string; label: string; kind: WKind; value: string | number; options?: string[]; min?: number; max?: number; step?: number; model?: ModelKind };
export type NDef = {
  type: string; title: string; cat: Cat; w: number; cost: number;
  inputs: { name: string; type: SType; optional?: boolean; widget?: string }[]; outputs: { name: string; type: SType }[]; widgets: WDef[];
  output?: boolean; preview?: boolean; write?: boolean;
};

export type ModelKind = 'checkpoints' | 'loras' | 'vae' | 'controlnet' | 'upscale_models';
export type Model = { name: string; kind: ModelKind; size: string; source: string; installed: boolean; note?: string };
export const MODEL_KIND: Record<ModelKind, string> = { checkpoints: 'Checkpoint', loras: 'LoRA', vae: 'VAE', controlnet: 'ControlNet', upscale_models: '放大模型' };
export const MODELS: Model[] = [
  { name: 'rhine_ink_xl_v2.safetensors', kind: 'checkpoints', size: '6.9 GB', source: '本地训练', installed: true, note: '莱茵墨线 · 黑白 + 橙' },
  { name: 'sdxl_base_1.0.safetensors', kind: 'checkpoints', size: '6.9 GB', source: 'Hugging Face', installed: true },
  { name: 'juggernautXL_v9.safetensors', kind: 'checkpoints', size: '7.1 GB', source: 'CivitAI', installed: true },
  { name: 'flux1-dev-fp8.safetensors', kind: 'checkpoints', size: '11.9 GB', source: 'Hugging Face', installed: false },
  { name: 'shire_watercolor_v3.safetensors', kind: 'loras', size: '228 MB', source: 'CivitAI', installed: false, note: '夏尔水彩' },
  { name: 'rhine_poster_style.safetensors', kind: 'loras', size: '163 MB', source: '本地训练', installed: true, note: '莱茵海报版式' },
  { name: 'maple_leaves_xl.safetensors', kind: 'loras', size: '144 MB', source: 'CivitAI', installed: true },
  { name: 'sdxl_vae.safetensors', kind: 'vae', size: '335 MB', source: 'Hugging Face', installed: true },
  { name: 'controlnet-lineart-sdxl.safetensors', kind: 'controlnet', size: '2.5 GB', source: 'Hugging Face', installed: true },
  { name: 'controlnet-canny-sdxl.safetensors', kind: 'controlnet', size: '2.5 GB', source: 'Hugging Face', installed: true },
  { name: '4x-UltraSharp.pth', kind: 'upscale_models', size: '67 MB', source: 'OpenModelDB', installed: true },
];
export const modelsOf = (k: ModelKind) => MODELS.filter(m => m.kind === k).map(m => m.name);

const SAMPLERS = ['euler', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_3m_sde', 'uni_pc'];
const SCHED = ['normal', 'karras', 'exponential', 'sgm_uniform'];
const ARCHIVES = ['C—008 作品档案', 'R—014 资料库', 'P—013 旅程档案'];
const m = (name: string, label: string, kind: ModelKind): WDef => ({ name, label, kind: 'combo', value: modelsOf(kind)[0], options: modelsOf(kind), model: kind });
const num = (name: string, label: string, value: number, min: number, max: number, step = 1, kind: WKind = step < 1 ? 'float' : 'int'): WDef => ({ name, label, kind, value, min, max, step });

export const DEFS: NDef[] = [
  { type: 'CheckpointLoaderSimple', title: '加载 Checkpoint', cat: '加载器', w: 250, cost: .8, inputs: [], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }, { name: 'VAE', type: 'VAE' }], widgets: [m('ckpt_name', 'ckpt_name', 'checkpoints')] },
  { type: 'LoraLoader', title: '加载 LoRA', cat: '加载器', w: 250, cost: .4, inputs: [{ name: 'model', type: 'MODEL' }, { name: 'clip', type: 'CLIP' }], outputs: [{ name: 'MODEL', type: 'MODEL' }, { name: 'CLIP', type: 'CLIP' }], widgets: [m('lora_name', 'lora_name', 'loras'), num('strength_model', 'strength_model', .8, -2, 2, .05), num('strength_clip', 'strength_clip', .8, -2, 2, .05)] },
  { type: 'CLIPTextEncode', title: 'CLIP 文本编码', cat: '条件', w: 270, cost: .2, inputs: [{ name: 'clip', type: 'CLIP' }, { name: 'text', type: 'TEXT', optional: true, widget: 'text' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets: [{ name: 'text', label: 'text', kind: 'text', value: '' }] },
  { type: 'EmptyLatentImage', title: '空潜空间图像', cat: '潜空间', w: 220, cost: .1, inputs: [], outputs: [{ name: 'LATENT', type: 'LATENT' }], widgets: [num('width', 'width', 1024, 512, 2048, 64), num('height', 'height', 1024, 512, 2048, 64), num('batch_size', 'batch_size', 2, 1, 8)] },
  { type: 'KSampler', title: 'K 采样器', cat: '采样', w: 260, cost: 0, inputs: [{ name: 'model', type: 'MODEL' }, { name: 'positive', type: 'CONDITIONING' }, { name: 'negative', type: 'CONDITIONING' }, { name: 'latent_image', type: 'LATENT' }], outputs: [{ name: 'LATENT', type: 'LATENT' }],
    widgets: [num('seed', 'seed', 1184, 0, 2 ** 32, 1, 'seed'), { name: 'control_after_generate', label: 'control_after_generate', kind: 'combo', value: 'randomize', options: ['fixed', 'increment', 'decrement', 'randomize'] }, num('steps', 'steps', 20, 1, 100), num('cfg', 'cfg', 6.5, 0, 20, .5), { name: 'sampler_name', label: 'sampler_name', kind: 'combo', value: 'dpmpp_2m', options: SAMPLERS }, { name: 'scheduler', label: 'scheduler', kind: 'combo', value: 'karras', options: SCHED }, num('denoise', 'denoise', 1, 0, 1, .05)] },
  { type: 'VAEDecode', title: 'VAE 解码', cat: '潜空间', w: 190, cost: .5, inputs: [{ name: 'samples', type: 'LATENT' }, { name: 'vae', type: 'VAE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [] },
  { type: 'SaveImage', title: '保存图像', cat: '图像', w: 270, cost: .3, output: true, preview: true, inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [], widgets: [{ name: 'filename_prefix', label: 'filename_prefix', kind: 'string', value: 'ReinLab' }] },
  { type: 'PreviewImage', title: '预览图像', cat: '图像', w: 240, cost: .1, output: true, preview: true, inputs: [{ name: 'images', type: 'IMAGE' }], outputs: [], widgets: [] },
  { type: 'LoadImage', title: '加载图像', cat: '图像', w: 230, cost: .2, inputs: [], outputs: [{ name: 'IMAGE', type: 'IMAGE' }, { name: 'MASK', type: 'MASK' }], widgets: [{ name: 'image', label: 'image', kind: 'combo', value: 'redbook_ch3_lineart.png', options: ['redbook_ch3_lineart.png', 'mallorn_sketch.png', 'cover_v3.png'] }] },
  { type: 'ControlNetLoader', title: '加载 ControlNet', cat: 'ControlNet', w: 260, cost: .5, inputs: [], outputs: [{ name: 'CONTROL_NET', type: 'CONTROL_NET' }], widgets: [m('control_net_name', 'control_net_name', 'controlnet')] },
  { type: 'ControlNetApply', title: '应用 ControlNet', cat: 'ControlNet', w: 230, cost: .3, inputs: [{ name: 'conditioning', type: 'CONDITIONING' }, { name: 'control_net', type: 'CONTROL_NET' }, { name: 'image', type: 'IMAGE' }], outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING' }], widgets: [num('strength', 'strength', .85, 0, 2, .05)] },
  { type: 'UpscaleModelLoader', title: '加载放大模型', cat: '放大', w: 220, cost: .2, inputs: [], outputs: [{ name: 'UPSCALE_MODEL', type: 'UPSCALE_MODEL' }], widgets: [m('model_name', 'model_name', 'upscale_models')] },
  { type: 'ImageUpscaleWithModel', title: '模型放大图像', cat: '放大', w: 220, cost: 1.4, inputs: [{ name: 'upscale_model', type: 'UPSCALE_MODEL' }, { name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }], widgets: [] },
  { type: 'RhineReadArchive', title: '读档案', cat: '通用', w: 240, cost: .3, inputs: [], outputs: [{ name: 'text', type: 'TEXT' }, { name: 'entry', type: 'DOC' }], widgets: [{ name: 'archive', label: 'archive', kind: 'combo', value: ARCHIVES[0], options: ARCHIVES }, { name: 'query', label: 'query', kind: 'string', value: '最新定稿' }] },
  { type: 'RhineAgentPrompt', title: 'Agent 写提示词', cat: '通用', w: 260, cost: 1.2, inputs: [{ name: 'context', type: 'TEXT' }], outputs: [{ name: 'positive', type: 'TEXT' }, { name: 'negative', type: 'TEXT' }], widgets: [{ name: 'instruction', label: 'instruction', kind: 'text', value: '读作品摘要，写一段封面提示词：莱茵生命海报版式，黑白为主，一处橙色。' }] },
  { type: 'RhineWriteArchive', title: '写入档案', cat: '通用', w: 240, cost: .4, output: true, write: true, inputs: [{ name: 'images', type: 'IMAGE' }, { name: 'entry', type: 'DOC', optional: true }], outputs: [], widgets: [{ name: 'target', label: 'target', kind: 'combo', value: ARCHIVES[0], options: ARCHIVES }, { name: 'mode', label: 'mode', kind: 'combo', value: '设为封面', options: ['设为封面', '追加到附件'] }] },
];
export const DEF = Object.fromEntries(DEFS.map(d => [d.type, d])) as Record<string, NDef>;

/* ———— 节点的几何（不量 DOM，按行数算出插槽位置，连线才能直接画） ———— */
export const H0 = 30, ROW = 22, WROW = 26, TEXT_H = 84, PAD = 8, PREV_H = 196, PROG_H = 22;
export type GNode = { id: string; type: string; x: number; y: number; v: Record<string, string | number>; title?: string };
export type GLink = { id: string; from: [string, number]; to: [string, number]; type: SType };
export type GGroup = { id: string; title: string; x: number; y: number; w: number; h: number };
const linkedTextHidden = (n: GNode, links: GLink[], w: WDef) => DEF[n.type].inputs.some((s, i) => s.widget === w.name && links.some(l => l.to[0] === n.id && l.to[1] === i));
export const widgetRows = (n: GNode, links: GLink[]) => DEF[n.type].widgets.map(w => ({ w, h: w.kind === 'text' ? (linkedTextHidden(n, links, w) ? WROW : TEXT_H) : WROW, linked: linkedTextHidden(n, links, w) }));
export function nodeSize(n: GNode, links: GLink[]) {
  const d = DEF[n.type], rows = Math.max(d.inputs.length, d.outputs.length);
  const wh = widgetRows(n, links).reduce((s, r) => s + r.h, 0);
  return { w: d.w, h: H0 + rows * ROW + (wh ? 4 + wh : 0) + (d.type === 'KSampler' ? PROG_H : 0) + (d.preview ? PREV_H : 0) + PAD };
}
export const inPos = (n: GNode, i: number) => ({ x: n.x, y: n.y + H0 + i * ROW + ROW / 2 });
export const outPos = (n: GNode, i: number) => ({ x: n.x + DEF[n.type].w, y: n.y + H0 + i * ROW + ROW / 2 });

/** 从输出节点往回找，得到这次要执行的节点及顺序（拓扑序）。 */
export function execOrder(nodes: GNode[], links: GLink[]) {
  const order: string[] = [], seen = new Set<string>();
  const visit = (id: string) => { if (seen.has(id)) return; seen.add(id); links.filter(l => l.to[0] === id).forEach(l => visit(l.from[0])); order.push(id); };
  nodes.filter(n => DEF[n.type].output).forEach(n => visit(n.id));
  return order;
}
/** 校验：必需的输入没接、引用的模型没装，都报错（对应 ComfyUI 的 Prompt outputs failed validation）。 */
export function validate(nodes: GNode[], links: GLink[], installed: (name: string) => boolean) {
  const errs: Record<string, string> = {};
  for (const id of execOrder(nodes, links)) {
    const n = nodes.find(x => x.id === id)!, d = DEF[n.type];
    const miss = d.inputs.findIndex((s, i) => !s.optional && !links.some(l => l.to[0] === id && l.to[1] === i));
    if (miss >= 0) { errs[id] = `必需输入「${d.inputs[miss].name}」没有连接`; continue; }
    const mw = d.widgets.find(w => w.model && !installed(String(n.v[w.name])));
    if (mw) errs[id] = `模型没有安装：${n.v[mw.name]}`;
  }
  return errs;
}
/** 节点的缓存键：类型 + 参数 + 上游的键。没变的节点在下一次运行里直接用缓存。 */
export function hashes(nodes: GNode[], links: GLink[]) {
  const memo: Record<string, string> = {};
  const h = (id: string): string => {
    if (memo[id]) return memo[id];
    const n = nodes.find(x => x.id === id)!;
    const up = links.filter(l => l.to[0] === id).sort((a, b) => a.to[1] - b.to[1]).map(l => `${l.to[1]}<${h(l.from[0])}.${l.from[1]}`).join('|');
    return (memo[id] = `${n.type}${JSON.stringify(n.v)}[${up}]`);
  };
  nodes.forEach(n => h(n.id));
  return memo;
}

/* ———— 工作区（Workspace Manager） ———— */
export type Output = { id: string; seed: number; at: string; w: number; h: number; theme: string; prompt: string };
export type Workflow = {
  id: string; name: string; folder: string; tags: string[]; nodes: GNode[]; links: GLink[]; groups: GGroup[];
  versions: { v: string; at: string; note: string; nodes: GNode[]; links: GLink[] }[]; saved: boolean; updated: string;
  outputs: Output[]; tool?: { id: string; params: string[]; published: boolean; usedBy: string[] };
};
const N = (id: string, type: string, x: number, y: number, v: Record<string, string | number> = {}, title?: string): GNode =>
  ({ id, type, x, y, title, v: { ...Object.fromEntries(DEF[type].widgets.map(w => [w.name, w.value])), ...v } });
let lk = 0;
const L = (from: string, fo: number, to: string, ti: number, nodes: GNode[]): GLink => {
  const f = nodes.find(n => n.id === from)!; return { id: `l${++lk}`, from: [from, fo], to: [to, ti], type: DEF[f.type].outputs[fo].type };
};
export const newLinkId = () => `l${++lk}`;
const wf = (w: Omit<Workflow, 'links' | 'versions' | 'saved'> & { links: [string, number, string, number][]; version: [string, string, string] }): Workflow => {
  const links = w.links.map(([a, b, c, d]) => L(a, b, c, d, w.nodes));
  return { ...w, links, saved: true, versions: [{ v: w.version[0], at: w.version[1], note: w.version[2], nodes: w.nodes, links }] };
};

const NEG = '模糊，低质量，多余的手指，水印，文字错误';
export const WORKFLOWS: Workflow[] = [
  wf({ id: 'WFG-01', name: '夏尔插画 · 基础出图', folder: '创作台/红皮书插画', tags: ['txt2img', 'LoRA'], updated: '10-14', version: ['v3', '10-14', 'LoRA 换成夏尔水彩 v3'],
    nodes: [
      N('ck', 'CheckpointLoaderSimple', 20, 120, { ckpt_name: 'juggernautXL_v9.safetensors' }),
      N('lo', 'LoraLoader', 310, 40, { lora_name: 'shire_watercolor_v3.safetensors', strength_model: .75, strength_clip: .7 }),
      N('pos', 'CLIPTextEncode', 610, 0, { text: '夏尔的秋天，袋底洞圆门外的花园，山姆和女儿伊拉诺在栽种梅隆树苗，水彩，柔和晨光' }, '正向提示词'),
      N('neg', 'CLIPTextEncode', 610, 210, { text: NEG }, '负向提示词'),
      N('lat', 'EmptyLatentImage', 640, 420, { width: 1216, height: 832, batch_size: 2 }),
      N('ks', 'KSampler', 930, 60, { seed: 1184 }),
      N('dec', 'VAEDecode', 1230, 60),
      N('sv', 'SaveImage', 1230, 200, { filename_prefix: 'shire/ch3' }),
    ],
    links: [['ck', 0, 'lo', 0], ['ck', 1, 'lo', 1], ['lo', 0, 'ks', 0], ['lo', 1, 'pos', 0], ['lo', 1, 'neg', 0], ['pos', 0, 'ks', 1], ['neg', 0, 'ks', 2], ['lat', 0, 'ks', 3], ['ks', 0, 'dec', 0], ['ck', 2, 'dec', 1], ['dec', 0, 'sv', 0]],
    groups: [{ id: 'g1', title: '模型与风格', x: 0, y: 0, w: 580, h: 300 }, { id: 'g2', title: '提示词', x: 595, y: -40, w: 300, h: 420 }],
    outputs: [{ id: 'o1', seed: 1183, at: '10-14 21:02', w: 1216, h: 832, theme: 'shire', prompt: '夏尔的秋天，袋底洞圆门…' }, { id: 'o2', seed: 1182, at: '10-14 21:01', w: 1216, h: 832, theme: 'shire', prompt: '夏尔的秋天，袋底洞圆门…' }, { id: 'o3', seed: 977, at: '10-12 18:40', w: 1216, h: 832, theme: 'shire', prompt: '梅隆树下的山姆' }] }),
  wf({ id: 'WFG-02', name: '红皮书 · 线稿上色', folder: '创作台/红皮书插画', tags: ['ControlNet', 'lineart'], updated: '10-11', version: ['v2', '10-11', 'ControlNet 强度 0.85'],
    nodes: [
      N('ck', 'CheckpointLoaderSimple', 20, 40, { ckpt_name: 'rhine_ink_xl_v2.safetensors' }),
      N('img', 'LoadImage', 20, 230),
      N('cn', 'ControlNetLoader', 20, 380, { control_net_name: 'controlnet-lineart-sdxl.safetensors' }),
      N('pos', 'CLIPTextEncode', 320, 0, { text: '红皮书第 3 章插图，墨线上色，黑白为主，橙色只用在灯火上' }, '正向提示词'),
      N('neg', 'CLIPTextEncode', 320, 210, { text: NEG }, '负向提示词'),
      N('app', 'ControlNetApply', 640, 0),
      N('lat', 'EmptyLatentImage', 640, 170, { width: 1024, height: 1024, batch_size: 1 }),
      N('ks', 'KSampler', 900, 0, { seed: 4021, steps: 24 }),
      N('dec', 'VAEDecode', 1200, 0),
      N('sv', 'SaveImage', 1200, 130, { filename_prefix: 'redbook/color' }),
    ],
    links: [['ck', 1, 'pos', 0], ['ck', 1, 'neg', 0], ['pos', 0, 'app', 0], ['cn', 0, 'app', 1], ['img', 0, 'app', 2], ['ck', 0, 'ks', 0], ['app', 0, 'ks', 1], ['neg', 0, 'ks', 2], ['lat', 0, 'ks', 3], ['ks', 0, 'dec', 0], ['ck', 2, 'dec', 1], ['dec', 0, 'sv', 0]],
    groups: [{ id: 'g1', title: '线稿约束', x: 0, y: 200, w: 290, h: 300 }],
    outputs: [{ id: 'o1', seed: 4020, at: '10-11 16:20', w: 1024, h: 1024, theme: 'line', prompt: '红皮书第 3 章插图' }] }),
  wf({ id: 'WFG-03', name: '定稿封面', folder: '例程工具', tags: ['例程工具', 'Agent', '写入'], updated: '10-16', version: ['v4', '10-16', '封面放大到 4x，写回 C—008'],
    nodes: [
      N('rd', 'RhineReadArchive', 20, 30),
      N('ag', 'RhineAgentPrompt', 300, 30),
      N('ck', 'CheckpointLoaderSimple', 20, 330, { ckpt_name: 'rhine_ink_xl_v2.safetensors' }),
      N('lo', 'LoraLoader', 300, 330, { lora_name: 'rhine_poster_style.safetensors', strength_model: .9, strength_clip: .85 }),
      N('pos', 'CLIPTextEncode', 610, 30, {}, '正向提示词'),
      N('neg', 'CLIPTextEncode', 610, 180, {}, '负向提示词'),
      N('lat', 'EmptyLatentImage', 610, 330, { width: 832, height: 1216, batch_size: 4 }),
      N('ks', 'KSampler', 900, 30, { seed: 2610, steps: 28, cfg: 7 }),
      N('dec', 'VAEDecode', 1200, 30),
      N('up', 'UpscaleModelLoader', 1200, 140),
      N('ups', 'ImageUpscaleWithModel', 1200, 250),
      N('sv', 'SaveImage', 1460, 30, { filename_prefix: 'covers/final' }),
      N('wr', 'RhineWriteArchive', 1460, 360),
    ],
    links: [['rd', 0, 'ag', 0], ['ag', 0, 'pos', 1], ['ag', 1, 'neg', 1], ['ck', 0, 'lo', 0], ['ck', 1, 'lo', 1], ['lo', 1, 'pos', 0], ['lo', 1, 'neg', 0], ['lo', 0, 'ks', 0], ['pos', 0, 'ks', 1], ['neg', 0, 'ks', 2], ['lat', 0, 'ks', 3], ['ks', 0, 'dec', 0], ['ck', 2, 'dec', 1], ['up', 0, 'ups', 0], ['dec', 0, 'ups', 1], ['ups', 0, 'sv', 0], ['ups', 0, 'wr', 0], ['rd', 1, 'wr', 1]],
    groups: [{ id: 'g1', title: '读作品 · 写提示词（通用节点）', x: 0, y: -10, w: 580, h: 300 }, { id: 'g2', title: '出图', x: 0, y: 300, w: 1170, h: 260 }],
    outputs: [{ id: 'o1', seed: 2609, at: '10-16 21:14', w: 832, h: 1216, theme: 'cover', prompt: '《红皮书的最后一页》封面' }, { id: 'o2', seed: 2608, at: '10-16 21:14', w: 832, h: 1216, theme: 'cover', prompt: '《红皮书的最后一页》封面' }],
    tool: { id: 'cover_graph', params: ['rd.query', 'ks.seed', 'lat.batch_size'], published: true, usedBy: ['WF-05'] } }),
  wf({ id: 'WFG-04', name: '封面放大 4x', folder: '例程工具', tags: ['upscale'], updated: '10-02', version: ['v1', '10-02', '初版'],
    nodes: [N('img', 'LoadImage', 20, 40, { image: 'cover_v3.png' }), N('up', 'UpscaleModelLoader', 20, 200), N('ups', 'ImageUpscaleWithModel', 300, 80), N('sv', 'SaveImage', 580, 40, { filename_prefix: 'covers/4x' })],
    links: [['up', 0, 'ups', 0], ['img', 0, 'ups', 1], ['ups', 0, 'sv', 0]], groups: [], outputs: [] }),
];

/** 一句话搭图：按标准文生图模板摆出节点，提示词取自原话（关键词模拟）。 */
export function buildFromText(text: string, n: number): Workflow {
  const core = text.replace(/^(帮我|请)?(搭|做|生成|画)(一个|一张|个|张)?/, '').replace(/[，,。]?\s*\d+\s*张.*$/, '').trim() || text;
  const tall = /竖|海报|封面|手机/.test(text), wide = /横|宽|风景|banner/i.test(text);
  const batch = Math.min(8, +(text.match(/(\d+)\s*张/)?.[1] ?? 2));
  const theme = /枫|红叶|秋/.test(text) ? 'maple' : /夏尔|霍比特|山姆/.test(text) ? 'shire' : /封面|海报/.test(text) ? 'cover' : 'line';
  const lora = theme === 'maple' ? 'maple_leaves_xl.safetensors' : 'rhine_poster_style.safetensors';
  const nodes = [
    N('ck', 'CheckpointLoaderSimple', 20, 120, { ckpt_name: 'rhine_ink_xl_v2.safetensors' }),
    N('lo', 'LoraLoader', 310, 40, { lora_name: lora }),
    N('pos', 'CLIPTextEncode', 610, 0, { text: `${core}，莱茵生命版式，黑白为主，一处橙色` }, '正向提示词'),
    N('neg', 'CLIPTextEncode', 610, 210, { text: NEG }, '负向提示词'),
    N('lat', 'EmptyLatentImage', 640, 420, { width: tall ? 832 : wide ? 1216 : 1024, height: tall ? 1216 : wide ? 832 : 1024, batch_size: batch }),
    N('ks', 'KSampler', 930, 60, { seed: 3000 + n * 17 }),
    N('dec', 'VAEDecode', 1230, 60),
    N('sv', 'SaveImage', 1230, 200, { filename_prefix: `draft/${n}` }),
  ];
  const links: [string, number, string, number][] = [['ck', 0, 'lo', 0], ['ck', 1, 'lo', 1], ['lo', 0, 'ks', 0], ['lo', 1, 'pos', 0], ['lo', 1, 'neg', 0], ['pos', 0, 'ks', 1], ['neg', 0, 'ks', 2], ['lat', 0, 'ks', 3], ['ks', 0, 'dec', 0], ['ck', 2, 'dec', 1], ['dec', 0, 'sv', 0]];
  return wf({ id: `WFG-${String(n).padStart(2, '0')}`, name: core.slice(0, 10), folder: '草稿', tags: ['txt2img', '草稿'], updated: '刚才', version: ['v1', '刚才', '由一句话搭出'], nodes, links, groups: [], outputs: [] });
}

let nn = 0;
/** 画布上新加的节点：参数取默认值。 */
export const makeNode = (type: string, x: number, y: number): GNode => N(`${type.replace(/[a-z]/g, '').toLowerCase() || 'n'}${++nn}`, type, Math.round(x), Math.round(y));
