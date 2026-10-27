import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DockDraft, DockEvent } from '../../AgentDock';
import { hm, initData, makeOnboard, pv, rng, step, RISK_TEXT, STATE_TEXT, UNITS, type LiveData, type Onboard, type Param, type Unit } from './liveModel';

// 看板的控制器：每 1.5 秒推进一拍（= 1 分钟）；参数修改按风险分流（低风险直接生效，中 / 高风险走审批卡）；
// 接入流水线 侦查 → 适配 → 沙盒试跑 → 你批准上线；以及维护 Agent 的对话。全部为前端模拟。

export type LogLine = { t: string; kind: 'info' | 'param' | 'alert' | 'deploy' | 'warn'; text: string };
type Api = {
  push: (e: DockDraft) => string; say: (t: ReactNode) => void; patch: (id: string, p: Partial<DockEvent>) => void;
  settle: (id: string, ok: boolean) => void; later: (ms: number, fn: () => void) => void; reduced: boolean;
};
const TICK = 1500;
const bump = (v: string) => `v${(parseFloat(v.slice(1)) + 0.1).toFixed(1)}`;
const show = (v: Param['value']) => Array.isArray(v) ? v.join('、') : String(v);

export function useLive(active: boolean, api: Api) {
  const [units, setUnits] = useState<Unit[]>(() => JSON.parse(JSON.stringify(UNITS)));
  const [data, setData] = useState<Record<string, LiveData>>(() => Object.fromEntries(UNITS.map(u => [u.id, initData(u)])));
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'panel' | 'yaml' | 'log'>('panel');
  const [logs, setLogs] = useState<Record<string, LogLine[]>>(() => Object.fromEntries(UNITS.map(u => [u.id, [
    { t: '09:30', kind: 'info', text: `运行器启动 ${u.id} · ${u.runtime}` }, { t: '09:30', kind: 'info', text: `网络放行：${u.network.join('、')}` },
    { t: '09:31', kind: 'info', text: u.kind === 'simulation' ? '等待手动运行' : '第一拍数据已写入 · rl.emit 正常' },
  ]])));
  const [pending, setPending] = useState<Record<string, Param['value']>>({});
  const [onboard, setOnboard] = useState<Onboard | null>(null);
  const [trial, setTrial] = useState<LiveData | null>(null);
  const S = useRef({ units, data, onboard, trial, sel }); S.current = { units, data, onboard, trial, sel };
  const alerted = useRef<Record<string, string | null>>({});
  const sandboxTool = useRef<string | null>(null);
  const calm = useRef<Record<string, number>>({}); // 连续正常的拍数：告警立即触发，连续 5 拍正常才解除，避免在阈值附近来回跳

  const log = (id: string, kind: LogLine['kind'], text: string, minute?: number) =>
    setLogs(m => ({ ...m, [id]: [{ t: hm(minute ?? S.current.data[id]?.minute ?? 576), kind, text }, ...(m[id] ?? [])].slice(0, 60) }));

  /* ———— 推进一拍 ———— */
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(() => {
      const { units: us, data: ds } = S.current; const next: Record<string, LiveData> = { ...ds };
      for (const u of us) {
        if (u.state === 'paused') continue;
        if (u.kind === 'simulation' && !ds[u.id]?.sim?.running) continue;
        next[u.id] = step(u, ds[u.id], rng(u.id.charCodeAt(4) * 977 + ds[u.id].minute));
      }
      setData(next);
      // 告警只在状态翻转时通知一次
      const flips: [string, string | null][] = [];
      for (const u of us) {
        if (u.kind !== 'live' || u.state === 'paused') continue;
        const a = next[u.id]?.alert ?? null, was = alerted.current[u.id] ?? null;
        calm.current[u.id] = a ? 0 : (calm.current[u.id] ?? 0) + 1;
        if (a && !was) flips.push([u.id, a]);
        else if (!a && was && calm.current[u.id] >= 5) flips.push([u.id, null]);
      }
      if (flips.length) {
        setUnits(l => l.map(u => { const f = flips.find(x => x[0] === u.id); return f && u.state !== 'paused' && u.state !== 'fail' ? { ...u, state: f[1] ? 'alert' : 'ok' } : u; }));
        for (const [id, a] of flips) {
          const u = us.find(x => x.id === id)!; alerted.current[id] = a;
          if (a) { log(id, 'alert', `告警：${a}`, next[id].minute); api.push({ kind: 'card', body: <div className="lv-alertcard"><b>{id} · {u.title}</b><span>{a}</span><small>{hm(next[id].minute)} · 已进收件箱 · 只告警，不做任何对外动作</small></div> }); }
          else log(id, 'info', '告警解除', next[id].minute);
        }
      }
      // 接入流程的沙盒试跑
      const ob = S.current.onboard, tr = S.current.trial;
      if (ob && ob.stage === 2 && tr) {
        setTrial(step(ob.unit, tr, rng(ob.trialTicks * 131 + 5)));
        const n = ob.trialTicks + 1; setOnboard({ ...ob, trialTicks: n });
        if (n >= 6) finishTrial({ ...ob, trialTicks: n });
      }
    }, api.reduced ? TICK * 2 : TICK);
    return () => clearInterval(h);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ———— 参数 ———— */
  const apply = (id: string, key: string, value: Param['value'], why: string) => {
    const u = S.current.units.find(x => x.id === id)!, p = u.params.find(x => x.key === key)!, v = bump(u.versions[0].v);
    const note = `${p.label}：${show(p.value)} → ${show(value)}`;
    setUnits(l => l.map(x => x.id !== id ? x : { ...x, params: x.params.map(q => q.key === key ? { ...q, value } : q), versions: [{ v, at: hm(S.current.data[id].minute), note }, ...x.versions] }));
    setPending(m => { const n = { ...m }; delete n[`${id}.${key}`]; return n; });
    log(id, 'param', `${v} · ${note}（${why}）`);
    if (u.kind === 'simulation') setData(m => ({ ...m, [id]: step({ ...u, params: u.params.map(q => q.key === key ? { ...q, value } : q) }, m[id], rng(3), true) }));
    return { v, note };
  };
  const setParam = (id: string, key: string, value: Param['value'], via: 'knob' | 'chat' = 'knob') => {
    const u = S.current.units.find(x => x.id === id)!, p = u.params.find(x => x.key === key)!;
    if (JSON.stringify(p.value) === JSON.stringify(value)) return;
    if (p.risk === 'low') {
      const t = api.push({ kind: 'tool', action: 'live.params.set', label: `${id} · ${p.label} → ${show(value)}`, state: 'running' });
      const r = apply(id, key, value, via === 'knob' ? '你拖动旋钮' : '对话里修改');
      api.patch(t, { state: 'done', ms: 40, detail: `${r.v} · 低风险，热更新生效，不用重启` } as Partial<DockEvent>);
      if (via === 'chat') api.say(<p>改好了：{r.note}。已存为 <b>{r.v}</b>，下一拍开始生效；不对的话说「回到上一版」。</p>);
      return;
    }
    setPending(m => ({ ...m, [`${id}.${key}`]: value }));
    log(id, 'warn', `等你批准：${p.label} → ${show(value)}`);
    const card = api.push({ kind: 'approval', action: `live.params.set ${id}.${key}`, title: `${id} ${u.title} · ${p.label} → ${show(value)}`,
      effects: [`风险：${RISK_TEXT[p.risk]}`, p.hint ?? '改动会写入版本记录', key === 'sources' ? '运行器会放行新来源对应的域名' : '下一拍开始生效，可一键回退'], risk: 'write', state: 'pending',
      onApprove: () => { api.settle(card, true); const r = apply(id, key, value, '你批准'); api.say(<p>已上线 <b>{r.v}</b>：{r.note}。</p>); },
      onReject: () => { api.settle(card, false); setPending(m => { const n = { ...m }; delete n[`${id}.${key}`]; return n; }); log(id, 'info', `驳回：${p.label} 保持 ${show(p.value)}`); api.say(<p>已驳回，{p.label}保持不变。</p>); } });
    if (via === 'chat') api.say(<p>这个改动风险是「{RISK_TEXT[p.risk]}」，我起草了，等你在上面批准。</p>);
  };
  const rollback = (id: string) => {
    const u = S.current.units.find(x => x.id === id)!; const last = u.versions[0];
    const m = last.note.match(/^(.+?)：(.+) → (.+)$/); const p = m && u.params.find(q => q.label === m[1]);
    if (!m || !p) return api.say(<p>{u.id} 的上一版改动（{last.note}）不是参数修改，回退要走维护面。</p>);
    const prev = Array.isArray(p.value) ? m[2].split('、') : p.kind === 'number' ? Number(m[2]) : m[2];
    const r = apply(id, p.key, prev, '回到上一版'); api.say(<p>已回退：{r.note}，存为 <b>{r.v}</b>。</p>);
  };
  const togglePause = (id: string) => {
    const u = S.current.units.find(x => x.id === id)!; const on = u.state === 'paused';
    setUnits(l => l.map(x => x.id === id ? { ...x, state: on ? (S.current.data[id]?.alert ? 'alert' : 'ok') : 'paused' } : x));
    log(id, 'info', on ? '已恢复' : '已暂停（运行器保留状态，不再采集）');
  };
  const runSim = (id: string) => {
    const u = S.current.units.find(x => x.id === id)!;
    setData(m => ({ ...m, [id]: { ...m[id], sim: { ...m[id].sim!, step: 1, running: true } } }));
    const t = api.push({ kind: 'tool', action: 'live.simulate', label: `${id} · ${(pv(u, 'agents') as number).toLocaleString('zh-CN')} 个智能体 · 方案「${pv(u, 'plan')}」+ 2 个对照`, state: 'running' });
    log(id, 'info', `开始模拟 · 方案 ${pv(u, 'plan')} · 48 小时`);
    api.later(TICK * 9, () => { api.patch(t, { state: 'done', ms: TICK * 9, detail: '48 小时 · 3 条曲线 · 可回放' } as Partial<DockEvent>); log(id, 'deploy', '模拟完成，结果已存为一次运行'); });
  };

  /* ———— 接入流水线 ———— */
  function finishTrial(ob: Onboard) {
    setOnboard({ ...ob, stage: 3 });
    if (sandboxTool.current) api.patch(sandboxTool.current, { state: 'done', ms: TICK * 6, detail: '6 / 6 拍正常 · 0 次对外写入' } as Partial<DockEvent>);
    const card = api.push({ kind: 'approval', action: `live.deploy ${ob.id}`, title: `上线 ${ob.id} ${ob.unit.title}`,
      effects: [`来源：${ob.unit.source.label}`, `网络只放行：${ob.unit.network.join('、')}`, '沙盒试跑 6 拍全部正常 · 0 次对外写入', '只观察和告警，不做对外动作'], risk: 'write', state: 'pending',
      onApprove: () => { api.settle(card, true); deploy(true); }, onReject: () => { api.settle(card, false); deploy(false); } });
    api.say(<p>沙盒里跑了 6 拍，数据和面板都正常，没有任何对外写入。上线要你批准。</p>);
  }
  const deploy = (ok: boolean) => {
    const ob = S.current.onboard, tr = S.current.trial; if (!ob) return;
    if (!ok) { setOnboard({ ...ob, stage: 4, result: 'rejected' }); return api.say(<p>没上线。沙盒和生成的四件套都留着，告诉我哪里要改。</p>); }
    const u: Unit = { ...ob.unit, state: 'ok' };
    setUnits(l => [...l, u]); setData(m => ({ ...m, [u.id]: tr ?? initData(u) }));
    setLogs(m => ({ ...m, [u.id]: [{ t: hm(tr?.minute ?? 576), kind: 'deploy', text: `上线 v1.0 · ${u.source.label}` }, { t: hm(tr?.minute ?? 576), kind: 'info', text: '沙盒试跑 6 拍通过' }] }));
    setOnboard({ ...ob, stage: 4, result: 'live' });
    api.say(<p><b>{u.id} {u.title}</b> 已上线，出现在看板上了。维护交给我：来源失效我会先诊断，改动照样要你批准。</p>);
  };
  const startOnboard = (text: string) => {
    if (S.current.onboard && S.current.onboard.stage < 4) return api.say(<p>{S.current.onboard.id} 还在接入中，等它走完再接下一个。</p>);
    const ob = makeOnboard(text, S.current.units.length - UNITS.length + 1);
    setOnboard(ob); setTrial(null); setSel('__onboard');
    const t = api.push({ kind: 'tool', action: 'live.scout', label: ob.from === 'github' ? `侦查 ${ob.unit.source.label.split(' ·')[0]} · 拉代码到沙盒` : '侦查 · 找数据来源', state: 'running' });
    api.later(1800, () => {
      api.patch(t, { state: 'done', ms: 1800, detail: `${ob.scout.length} 项 · ${ob.scout.filter(s => s[2] === 'warn').length} 项注意` } as Partial<DockEvent>);
      setOnboard(o => o && { ...o, stage: 1 });
      api.say(<p>侦查完了，能接。{ob.scout.find(s => s[2] === 'warn')?.[1]}。下面把它适配成四件套：脚本、参数、面板、告警。</p>);
      const t2 = api.push({ kind: 'tool', action: 'live.adapt', label: `生成 automation.yaml + main.py（数据改为 rl.emit）`, state: 'running' });
      const n = Math.ceil(ob.yaml.length / 36);
      for (let i = 1; i <= n; i++) api.later(i * 45, () => setOnboard(o => o && { ...o, typed: Math.min(ob.yaml.length, i * 36) }));
      api.later(n * 45 + 300, () => {
        api.patch(t2, { state: 'done', ms: n * 45, detail: `${ob.unit.params.length} 个旋钮 · ${ob.unit.panel.length} 块面板 · 1 条告警` } as Partial<DockEvent>);
        const now = Math.max(...Object.values(S.current.data).map(x => x.minute));
        setOnboard(o => o && { ...o, stage: 2, typed: ob.yaml.length }); setTrial({ ...initData(ob.unit, 11), minute: now });
        sandboxTool.current = api.push({ kind: 'tool', action: 'live.sandbox', label: `沙盒试跑 ${ob.id} · 6 拍 · 拦截一切对外写入`, state: 'running' });
      });
    });
  };

  /* ———— 对话 ———— */
  const send = (text: string): boolean => {
    if (/github\.com\/|接进来|接入|接到自动化/.test(text) || /^(帮我)?(盯一下|盯着|盯|监测|关注)/.test(text)) { startOnboard(text); return true; }
    if (/下单|买入|卖出|开仓|平仓|自动交易|抄底/.test(text)) {
      api.say(<p>这个我不做：常驻自动化只看、只算、只告警，不下单，也不给交易建议。想交易请你自己在交易所操作；我可以把告警条件调得更合适。</p>); return true;
    }
    const u = S.current.units.find(x => x.id === S.current.sel);
    if (!u) {
      const al = S.current.units.filter(x => x.state === 'alert');
      api.say(al.length ? <p>现在有 {al.length} 个在告警：{al.map(x => `${x.id} ${x.title}（${S.current.data[x.id].alert}）`).join('；')}。点开卡片可以调阈值或问我原因。</p>
        : <p>看板上 {S.current.units.length} 个自动化都正常。想接新东西，直接把 GitHub 链接或一句话想法发给我，比如「盯一下 RTX 5090 的二手价格」。</p>);
      return true;
    }
    const d = S.current.data[u.id];
    if (/回到上一版|回退|撤销/.test(text)) { rollback(u.id); return true; }
    if (/暂停|停一下/.test(text)) { togglePause(u.id); api.say(<p>{u.id} 已暂停。</p>); return true; }
    if (/恢复|继续跑/.test(text)) { if (u.state === 'paused') togglePause(u.id); api.say(<p>{u.id} 已恢复。</p>); return true; }
    if (u.kind === 'simulation' && /运行|跑一次|模拟|比较/.test(text)) { runSim(u.id); api.say(<p>开始模拟，当前方案用橙色，另外两条是对照。</p>); return true; }
    if (/为什么|告警|原因/.test(text)) {
      api.say(d.alert ? <p>{u.id} 告警是因为：{d.alert}。规则是「{u.alerts[0]}」。觉得太敏感可以说「阈值调到 …」。</p> : <p>{u.id} 现在没有告警。规则：{u.alerts[0] ?? '这个自动化没有设告警'}。</p>); return true;
    }
    if (/钉|pin/i.test(text)) { api.push({ kind: 'card', body: <div className="lv-alertcard is-pin"><b>已钉到 研究档案 R—014</b><span>{u.id} {u.title} 的面板会作为实时引用出现在档案页（示例）</span></div> }); return true; }
    const num = text.match(/-?\d+(\.\d+)?/);
    const numP = u.params.filter(p => p.kind === 'number');
    const target = numP.find(p => text.includes(p.label)) ?? numP.find(p => /阈值|告警/.test(p.label) && /阈值|告警/.test(text)) ?? (/阈值/.test(text) ? numP[numP.length - 1] : undefined);
    if (num && target) { setParam(u.id, target.key, Math.max(target.min ?? -Infinity, Math.min(target.max ?? Infinity, Number(num[0]))), 'chat'); return true; }
    if (/严|松|敏感/.test(text) && target) {
      const tighter = /严|敏感/.test(text) && !/不.*敏感|太敏感/.test(text);
      const dir = /振幅|波动|变化/.test(target.label) ? (tighter ? -1 : 1) : (tighter ? 1 : -1);
      const v = +((target.value as number) + dir * (target.step ?? 1)).toFixed(2); setParam(u.id, target.key, v, 'chat'); return true;
    }
    const multi = u.params.find(p => p.kind === 'multi' && p.options?.some(o => text.includes(o)));
    if (multi && /加上|增加|添加|去掉|删除|移除|不要/.test(text)) {
      const opt = multi.options!.find(o => text.includes(o))!; const cur = multi.value as string[];
      const add = /加上|增加|添加/.test(text); const v = add ? [...new Set([...cur, opt])] : cur.filter(x => x !== opt);
      if (!add && !v.length) { api.say(<p>至少要留一个{multi.label}。</p>); return true; }
      setParam(u.id, multi.key, v, 'chat'); return true;
    }
    api.say(<p>{u.id} {u.title}：{STATE_TEXT[u.state]}，{u.cadence === '按需' ? '按需运行' : `每 ${u.cadence.replace('m', ' 分钟')} 一拍`}。可调的有 {u.params.map(p => `「${p.label}」`).join('')}；直接说「{u.params.find(p => p.kind === 'number')?.label ?? '阈值'}调到 …」，或者「为什么告警」「回到上一版」。</p>);
    return true;
  };

  return { units, data, sel, setSel, tab, setTab, logs, pending, onboard, trial, setParam, togglePause, runSim, startOnboard, send, rollback, setOnboard };
}
export type LiveCtl = ReturnType<typeof useLive>;
