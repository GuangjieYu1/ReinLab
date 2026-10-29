import { useEffect, useRef, useState } from 'react';
import { DEF, execOrder, hashes, MODELS, validate, type GLink, type GNode, type Output, type Workflow } from './graphModel';
import { themeOf } from './Art';

// 队列执行（照 ComfyUI）：排队时先校验；按拓扑序逐个执行节点，参数和上游都没变的节点直接用缓存；
// K 采样器按步数推进；「写入档案」节点停下来等你批准。排队后按 control_after_generate 改种子。

export type NState = 'running' | 'done' | 'cached' | 'error' | 'wait' | 'skipped';
export type QItem = { id: string; wf: string; name: string; status: 'pending' | 'running' | 'done' | 'error'; at: string; seed: number; outputs: Output[] };
type Job = QItem & { nodes: GNode[]; links: GLink[] };
export type Live = { wf: string; s: Record<string, NState>; prog?: { id: string; step: number; steps: number }; notes: Record<string, string> };

const clock = () => { const d = new Date(); return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const installed = (name: string) => MODELS.find(m => m.name === name)?.installed ?? true;
let qn = 0;

export function useGraphRunner({ setWorkflows, reduced, ask, log }: {
  setWorkflows: (f: (l: Workflow[]) => Workflow[]) => void; reduced: boolean;
  ask: (wf: Workflow | { id: string; name: string }, node: GNode) => Promise<boolean>;
  log: (text: string) => void;
}) {
  const [queue, setQueue] = useState<QItem[]>([]);
  const [live, setLive] = useState<Live | null>(null);
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [latest, setLatest] = useState<Record<string, Output[]>>({});
  const jobs = useRef<Job[]>([]), busy = useRef(false), alive = useRef(true), cache = useRef<Record<string, Record<string, string>>>({});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, reduced ? 20 : ms));

  async function run(job: Job) {
    setQueue(q => q.map(x => x.id === job.id ? { ...x, status: 'running' } : x));
    const { nodes, links } = job, order = execOrder(nodes, links), H = hashes(nodes, links), prev = cache.current[job.wf] ?? {};
    const L: Live = { wf: job.wf, s: {}, notes: {} };
    const show = () => alive.current && setLive({ ...L, s: { ...L.s }, notes: { ...L.notes } });
    show();
    for (const id of order) {
      if (!alive.current) return;
      const n = nodes.find(x => x.id === id)!, d = DEF[n.type];
      if (prev[id] === H[id] && !d.output) { L.s[id] = 'cached'; show(); await wait(90); continue; }
      L.s[id] = 'running'; show();
      if (n.type === 'KSampler') {
        const steps = Number(n.v.steps);
        for (let s = 1; s <= steps; s++) { L.prog = { id, step: s, steps }; show(); await wait(2600 / steps); }
        L.prog = undefined;
      } else if (d.write) {
        L.s[id] = 'wait'; show();
        const ok = await ask({ id: job.wf, name: job.name }, n);
        L.s[id] = ok ? 'done' : 'skipped'; show(); continue;
      } else await wait(d.cost * 650 + 120);
      if (n.type === 'RhineReadArchive') L.notes[id] = `读到：《红皮书的最后一页》· ${n.v.query} · 第 3 章定稿 v4`;
      if (n.type === 'RhineAgentPrompt') L.notes[id] = `positive：《红皮书的最后一页》封面，袋底洞圆门剪影，梅隆树一片金叶为橙色，莱茵海报版式`;
      L.s[id] = 'done'; show();
    }
    cache.current[job.wf] = H;
    // 产出：批次数取自空潜空间图像，提示词取自正向提示词（接了 Agent 时取 Agent 写的）。
    const lat = nodes.find(x => x.type === 'EmptyLatentImage'), ks = nodes.find(x => x.type === 'KSampler');
    const pos = nodes.find(x => x.type === 'CLIPTextEncode' && x.title !== '负向提示词');
    const agent = pos && links.some(l => l.to[0] === pos.id && l.to[1] === 1);
    const prompt = agent ? '《红皮书的最后一页》封面' : String(pos?.v.text ?? nodes.find(x => x.type === 'LoadImage')?.v.image ?? '');
    const w = Number(lat?.v.width ?? 1024), h = Number(lat?.v.height ?? 1024), batch = Number(lat?.v.batch_size ?? 1), seed = Number(ks?.v.seed ?? job.seed);
    const up = nodes.some(x => x.type === 'ImageUpscaleWithModel');
    const outputs: Output[] = Array.from({ length: batch }, (_, i) => ({ id: `${job.id}-${i}`, seed: seed + i, at: clock(), w: up ? w * 4 : w, h: up ? h * 4 : h, theme: agent ? 'cover' : themeOf(prompt), prompt: prompt.slice(0, 40) }));
    if (!alive.current) return;
    setLatest(m => ({ ...m, [job.wf]: outputs }));
    setWorkflows(l => l.map(x => x.id === job.wf ? { ...x, outputs: [...outputs, ...x.outputs] } : x));
    setQueue(q => q.map(x => x.id === job.id ? { ...x, status: 'done', outputs } : x));
    log(`${job.id} 完成 · ${outputs.length} 张 · seed ${seed}${Object.values(L.s).filter(s => s === 'cached').length ? ` · ${Object.values(L.s).filter(s => s === 'cached').length} 个节点用了缓存` : ''}`);
  }
  async function pump() {
    if (busy.current) return;
    const job = jobs.current.shift(); if (!job) { setTimeout(() => alive.current && setLive(l => l && { ...l, prog: undefined }), 600); return; }
    busy.current = true; await run(job); busy.current = false; pump();
  }

  /** 排队：校验不过就返回错误；过了就按批次数排进队列，并按 control_after_generate 推进种子。 */
  function enqueue(wf: Workflow, count: number): Record<string, string> | null {
    const errs = validate(wf.nodes, wf.links, installed);
    setErrors(m => ({ ...m, [wf.id]: errs }));
    if (Object.keys(errs).length) return errs;
    let nodes = wf.nodes; const items: Job[] = [];
    for (let k = 0; k < count; k++) {
      const ks = nodes.find(x => x.type === 'KSampler');
      items.push({ id: `#${String(++qn).padStart(3, '0')}`, wf: wf.id, name: wf.name, status: 'pending', at: clock(), seed: Number(ks?.v.seed ?? 0), outputs: [], nodes, links: wf.links });
      nodes = nodes.map(n => {
        if (n.type !== 'KSampler') return n;
        const c = n.v.control_after_generate, s = Number(n.v.seed);
        return { ...n, v: { ...n.v, seed: c === 'increment' ? s + 1 : c === 'decrement' ? s - 1 : c === 'randomize' ? Math.floor(Math.random() * 99999) : s } };
      });
    }
    setWorkflows(l => l.map(x => x.id === wf.id ? { ...x, nodes } : x));
    jobs.current.push(...items); setQueue(q => [...q, ...items.map(({ nodes: _n, links: _l, ...rest }) => rest)]);
    pump();
    return null;
  }
  const clearErrors = (id: string) => setErrors(m => ({ ...m, [id]: {} }));
  const clearDone = () => setQueue(q => q.filter(x => x.status === 'pending' || x.status === 'running'));
  return { queue, live, errors, latest, enqueue, clearErrors, clearDone };
}
