import { useEffect, useRef, useState, type FormEvent } from 'react';
import { RhineMark } from '../rhine/RhineMark';
import type { CeremonyDesign } from '../cinematic/CeremonyWorkbenchChooser';
import { appendAccessLog, formatTime, readAccessLog, type AccessEntry } from './accessLog';
import { drawRibbon } from './ribbon';

// 伪登录：任意 4 位以上口令通过；更短的口令让整个场景原地进入「警示封锁」，2.6 秒后恢复。
const MIN_KEY = 4;
const DENY_MS = 2600;
const VERIFY_MS = 1400;
const CONFIRM_MS = 500;
// 准入后的转场：界面分层退场 → 缎带转正 → 细线收拢成刻度环，落在选台开场圆环的位置上，再淡出交给选台。
export const LOGIN_EXIT_MS = 3000;
export const LOGIN_HANDOFF_MS = 150; // 转场一开始就放出选台：它的开场组装在登录背景之下进行，刻度环成形、背景淡出时正好到位
// 锁定（从选台返回登录）：同一条时间轴倒放，刻度环散开回到缎带，界面分层回到原位。
const ARRIVE_MS = 1800;

type Phase = 'arrive-start' | 'arrive' | 'locked' | 'verifying' | 'confirmed' | 'denied' | 'exit';

const clamp = (v: number) => Math.max(0, Math.min(1, v));
const easeInOut = (t: number) => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

/** 选台开场圆环在屏幕上的位置，与 CeremonyWorkbenchChooser 的舞台缩放一致。 */
function ringFor(design: CeremonyDesign, w: number, h: number) {
  const portrait = w < h * .8;
  const s = portrait ? Math.min(w / 1180, h / 1080) : Math.min(w / 1920, h / 1080);
  const shiftY = portrait ? -h * (design === 'mobius' ? .02 : .1) : 0;
  return design === 'aperture'
    ? { x: w / 2 + (portrait ? 0 : 160 * s), y: h / 2 + shiftY, r: 262 * s }
    : { x: w / 2, y: h / 2 + shiftY, r: 276 * s };
}

/** 退场时间轴：p ∈ [0,1]；锁定时倒放。 */
function timeline(p: number) {
  return {
    turn: easeInOut(clamp(p / .3)),
    morph: easeInOut(clamp((p - .24) / .34)),
    fade: 1 - clamp((p - .8) / .2),
  };
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id); }, []);
  return now;
}

function useStageScale() {
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setView({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on); return () => window.removeEventListener('resize', on);
  }, []);
  return { ...view, scale: Math.min(view.w / 1920, view.h / 1080), compact: view.w < 900 || view.w < view.h * .9 };
}

type Props = { reduced: boolean; design: CeremonyDesign; arriving?: boolean; onVerify?: () => void; onExit: () => void; onArrived?: () => void };

export default function RhineLogin({ reduced, design, arriving = false, onVerify, onExit, onArrived }: Props) {
  const [phase, setPhase] = useState<Phase>(arriving && !reduced ? 'arrive-start' : 'locked');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [log, setLog] = useState<AccessEntry[]>(readAccessLog);
  const canvas = useRef<HTMLCanvasElement>(null);
  const motion = useRef({ yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, speed: 1, signal: 0, alert: 0, exitAt: 0, arriveAt: 0 });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const designRef = useRef(design);
  designRef.current = design;
  const input = useRef<HTMLInputElement>(null);
  const now = useClock();
  const { scale, compact } = useStageScale();
  const attempts = log.length;

  // 缎带：每帧软渲染。常态缓慢漂移；警示态变为铜橙色并加速；转场按时间轴转正、收拢成刻度环。
  useEffect(() => {
    const el = canvas.current; if (!el) return;
    const ctx = el.getContext('2d'); if (!ctx) return;
    let frame = 0, last = performance.now(), time = 8;
    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      el.width = el.clientWidth * dpr; el.height = el.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize(); window.addEventListener('resize', resize);
    const tick = (t: number) => {
      const dt = Math.min(.05, (t - last) / 1000); last = t;
      const m = motion.current, ph = phaseRef.current;
      m.yaw += (m.tYaw - m.yaw) * .05; m.pitch += (m.tPitch - m.pitch) * .05;
      m.alert += ((ph === 'denied' ? 1 : 0) - m.alert) * .08;
      m.speed += ((ph === 'verifying' ? 3 : ph === 'denied' ? 2.2 : 1) - m.speed) * .05;
      if (!reduced) { time += dt * m.speed; m.signal = (m.signal + dt * .07 * m.speed) % 1; }
      const p = ph === 'exit' ? clamp((t - m.exitAt) / (reduced ? 1 : LOGIN_EXIT_MS))
        : ph === 'arrive-start' ? 1
        : ph === 'arrive' ? 1 - clamp((t - m.arriveAt) / ARRIVE_MS) : 0;
      const { turn, morph, fade } = timeline(p);
      const w = el.clientWidth, h = el.clientHeight;
      drawRibbon(ctx, w, h, {
        time, yaw: m.yaw * (1 - turn), pitch: m.pitch * (1 - turn),
        zoom: 1 + .5 * turn, cx: .42 + .08 * turn,
        frontal: turn, scatter: 0, morph, ring: ringFor(designRef.current, w, h), fade: ph === 'arrive' || ph === 'arrive-start' ? Math.max(fade, .001) : fade,
        signal: m.signal, ink: m.alert > .5 ? '#e0803f' : '#141213', accent: '#ff7a1a', weight: 1 + m.alert * 1.6,
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', resize); };
  }, [reduced]);

  // 视差：缎带随指针轻微转向。
  useEffect(() => {
    if (reduced) return;
    const move = (e: PointerEvent) => {
      motion.current.tYaw = (e.clientX / window.innerWidth - .5) * .5;
      motion.current.tPitch = (e.clientY / window.innerHeight - .5) * .3;
    };
    window.addEventListener('pointermove', move); return () => window.removeEventListener('pointermove', move);
  }, [reduced]);

  useEffect(() => {
    if (phase === 'arrive-start') {
      // 先以退场后的样子挂上，下一帧再切到常态，让界面各层沿过渡回到原位。
      const id = requestAnimationFrame(() => requestAnimationFrame(() => { motion.current.arriveAt = performance.now(); setPhase('arrive'); }));
      return () => cancelAnimationFrame(id);
    }
    if (phase === 'arrive') { const id = setTimeout(() => { setPhase('locked'); onArrived?.(); }, ARRIVE_MS); return () => clearTimeout(id); }
    if (phase === 'denied') { const id = setTimeout(() => { setPhase('locked'); setKey(''); }, reduced ? 1200 : DENY_MS); return () => clearTimeout(id); }
    if (phase === 'verifying') { const id = setTimeout(() => setPhase('confirmed'), reduced ? 0 : VERIFY_MS); return () => clearTimeout(id); }
    if (phase === 'confirmed') {
      const id = setTimeout(() => { motion.current.exitAt = performance.now(); setPhase('exit'); onExit(); }, reduced ? 0 : CONFIRM_MS);
      return () => clearTimeout(id);
    }
  }, [phase, reduced, onExit, onArrived]);

  useEffect(() => { if (phase === 'locked') input.current?.focus(); }, [phase, compact]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (phase !== 'locked') return;
    if (!key.trim()) { setError('请输入授权口令'); input.current?.focus(); return; }
    const ok = key.trim().length >= MIN_KEY;
    setLog(appendAccessLog({ at: Date.now(), result: ok ? 'granted' : 'denied', length: key.trim().length }));
    setError('');
    setPhase(ok ? 'verifying' : 'denied');
    // 核验这 1.4 秒画面相对平静，趁这时挂上下一页最重的部分（档案场），交接时就不卡。
    if (ok) onVerify?.();
  }

  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  const date = now.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  const busy = phase === 'verifying' || phase === 'confirmed' || phase === 'exit' || phase === 'arrive' || phase === 'arrive-start';
  const denied = phase === 'denied';
  const status = denied ? '检测到非法访问，权限已被拒绝。' : phase === 'verifying' ? '正在核验授权口令' : phase === 'confirmed' || phase === 'exit' ? '身份已确认，准许进入' : '研究员，您的会话已锁定。请出示授权口令。';
  const statusEn = denied ? 'UNAUTHORIZED ACCESS DETECTED · PERMISSION DENIED' : phase === 'verifying' ? 'VERIFYING AUTHORIZATION KEY' : phase === 'confirmed' || phase === 'exit' ? 'IDENTITY CONFIRMED · ACCESS GRANTED' : 'YOUR SESSION IS LOCKED. PRESENT YOUR AUTHORIZATION KEY.';
  const recent = log.slice(-3).reverse();
  const count = String(attempts).padStart(2, '0');

  const form = (
    <form className="rl-auth" onSubmit={submit} noValidate>
      <div className="rl-auth-head"><span className="rh-micro">Authorization key</span><span className="rh-micro">Attempt · {count}</span></div>
      <div className="rl-auth-bar">
        <label className="rh-sr" htmlFor="rl-key">授权口令</label>
        <input id="rl-key" ref={input} type="password" autoComplete="off" spellCheck={false} placeholder="ENTER AUTHORIZATION KEY" value={key} disabled={busy || denied}
          aria-invalid={!!error} aria-describedby="rl-key-help" onChange={e => { setKey(e.target.value); if (error) setError(''); }} />
        <button type="submit" disabled={busy || denied}>{phase === 'verifying' ? 'VERIFYING' : phase === 'confirmed' || phase === 'exit' ? 'GRANTED' : 'REQUEST'}<span aria-hidden="true">→</span></button>
      </div>
      <div id="rl-key-help" className={`rl-auth-help${error ? ' is-error' : ''}`}>{error || '演示环境：任意 4 位以上口令即可通过'}</div>
    </form>
  );

  // 操作日志：真实记录每次尝试（时间 · 结果 · 口令位数），最新的在上。
  const logPanel = (
    <div className="rl-log" aria-label="COMMAND LOG">
      <span className="rl-log-tag rh-mono">LOG 07 · LOCAL · {count}</span>
      <strong className="rh-mono">COMMAND LOG</strong>
      {recent.length === 0
        ? <span className="rh-micro">Every attempt is recorded</span>
        : <ol className="rl-log-list">{recent.map(entry => <li key={entry.at} data-result={entry.result}><time className="rh-mono">{formatTime(entry.at)}</time><b className="rh-mono">{entry.result === 'granted' ? 'GRANTED' : 'DENIED'}</b><span className="rh-mono">{'•'.repeat(Math.min(entry.length, 8))}</span></li>)}</ol>}
    </div>
  );

  // 最左侧的终端回显：每次口令错误，淡淡地打出一行 permission denied（最新一行逐字打出）。
  const denials = log.filter(entry => entry.result === 'denied').slice(-7);
  const terminal = (
    <div className="rl-term" aria-hidden="true">
      {denials.map((entry, i) => <span key={entry.at} className={i === denials.length - 1 ? 'is-new' : ''} style={{ ['--chars' as string]: 42 }}>
        [{formatTime(entry.at)}] auth: permission denied · {String(log.indexOf(entry) + 1).padStart(2, '0')}
      </span>)}
    </div>
  );


  return (
    <div className="rh rl" data-phase={phase} data-theme={denied ? 'dark' : 'light'} data-compact={compact} data-motion={reduced ? 'reduce' : 'full'}>
      <div className="rl-bg" aria-hidden="true" />
      <div className="rl-bg-alert" aria-hidden="true" />
      <canvas ref={canvas} className="rl-ribbon" aria-hidden="true" />
      <div className="rl-verify" aria-hidden="true">
        <svg viewBox="0 0 200 200"><defs><path id="rl-ring" d="M100 100m-78 0a78 78 0 1 1 156 0a78 78 0 1 1-156 0" /></defs>
          <circle cx="100" cy="100" r="92" /><circle cx="100" cy="100" r="64" className="dash" />
          <text><textPath href="#rl-ring">VERIFYING IDENTITY · VERIFYING IDENTITY · VERIFYING IDENTITY ·</textPath></text></svg>
      </div>

      {compact ? (
        <div className="rl-compact">
          <div className="rl-clock-sm">{hh}:{mm}<span className="rh-micro">{date}</span></div>
          <div className="rl-compact-card">
            <span className="rh-inverse rh-mono">OPERATOR</span>
            <strong className="rh-display rl-op-sm">Researcher</strong>
            <span className="rh-micro">Archive · sealed section</span>
            {form}
          </div>
          <p className="rl-status" role="status">{status}</p>
        </div>
      ) : (
        <div className="rl-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
          <div className="rl-left">
            <div className="rl-sidecol rh-micro" aria-hidden="true">
              <span>Rhine lab interface</span><span>System 03.17 · stable</span><span>Node · local-01</span><i /><i /><i />
              <span>Keymap · US</span><span>Locale · zh-CN</span><span>Audio · muted</span>
            </div>
            <span className="rl-rule" aria-hidden="true" />
            <span className="rh-micro rl-locked-tag">Locked</span>
            <div className="rh-block rl-sealed">
              <div className="rl-sealed-name"><span className="rh-display">ARCH</span><RhineMark size={28} /></div>
              <span className="rh-micro">Archive · sealed section</span>
            </div>
            {logPanel}
            {terminal}
            <div className="rl-callout" style={{ left: 620, top: 128 }} aria-hidden="true"><span className="rh-micro">Section 001</span><b>Terminal node</b><span className="rh-micro">Ribbon · möbius · half twist</span></div>
            <div className="rl-callout" style={{ left: 560, top: 800 }} aria-hidden="true"><span className="rh-micro">Section 002</span><b>Session seal</b></div>
            <svg className="rl-leaders" width="1920" height="1080" aria-hidden="true">
              <polyline points="610,150 560,150 480,290" /><circle cx="480" cy="290" r="4" />
              <polyline points="550,822 500,822 430,730" /><circle cx="430" cy="730" r="4" />
            </svg>
          </div>

          <div className="rl-right">
            <div className="rl-clock">
              <span className="rl-clock-time">{hh}:{mm}<sup>{String(now.getSeconds()).padStart(2, '0')}</sup></span>
              <span className="rh-micro">{date}</span>
              <span className="rh-micro">Terminal · local · utc+8</span>
            </div>
            <section className="rl-card" aria-labelledby="rl-op">
              <span className="rl-ghost-name" aria-hidden="true">RLAB</span>
              <span className="rl-ghost-info" aria-hidden="true">INFO</span>
              <div className="rl-card-head"><span className="rh-micro">■ Section profile</span><span className="rh-boxed rh-mono">RHINE LAB LLC.</span></div>
              <div className="rl-card-body">
                <div className={`rl-avatar${phase === 'verifying' ? ' is-scan' : ''}`}>
                  <svg viewBox="0 0 120 140" aria-hidden="true"><circle cx="60" cy="48" r="26" /><path d="M14 140c4-34 22-52 46-52s42 18 46 52z" /></svg>
                  <span className="rl-avatar-tag rh-mono">PHOTO CLASSIFIED</span>
                </div>
                <div className="rl-op">
                  <span className="rl-op-tags"><span className="rh-inverse rh-mono">OPERATOR</span><span className="rh-micro">Session locked</span></span>
                  <strong id="rl-op" className="rh-display">Researcher</strong>
                  <div className="rl-op-loaded"><span className="rh-block rl-mini-block"><RhineMark size={12} /></span><div><span className="rh-micro">■ Personal information loaded</span><span className="rh-micro">ARCH-01 · locked {hh}:{mm}</span></div></div>
                  <dl className="rl-profile">
                    <div><dt>HOST</dt><dd>LOCAL</dd></div><div><dt>SESSION</dt><dd>ARCH</dd></div>
                    <div><dt>LOCKED AT</dt><dd>{hh}:{mm}</dd></div><div><dt>KEYMAP</dt><dd>US</dd></div>
                  </dl>
                </div>
              </div>
              <div className="rl-checks" aria-hidden="true">
                {['Key', 'Seal', 'Node'].map((label, i) => <span key={label} className={denied ? 'is-bad' : (phase === 'verifying' && i === 0) || phase === 'confirmed' || phase === 'exit' ? 'is-on' : ''}><i />{label}</span>)}
              </div>
              {form}
            </section>
          </div>

          <p className="rl-status" role="status"><b>{status}</b><span className="rh-micro">{statusEn}</span></p>
          <div className="rl-foot">
            <span className="rl-foot-section">{denied ? 'Defense section · lockdown' : 'Archive · sealed section'}</span>
            <span className="rh-micro rl-foot-ops"><span>● Hibernate</span><span>● Reboot</span><span>● Shutdown</span><span>● Audio</span></span>
            <span className="rh-micro">Powered by <b>Rhine Lab</b> —</span>
          </div>
        </div>
      )}

      {denied && (
        <div className="rl-warning" role="alert">
          <svg viewBox="0 0 24 22" aria-hidden="true"><path d="M12 2 23 21H1z" /><path d="M12 9v6M12 17.5v1" /></svg>
          <span className="rl-warning-box rh-mono">WARNING</span>
          <ul className="rh-mono"><li>Authorization failed</li><li>Access denied · attempt {count}</li><li>Lockdown · restore in {(DENY_MS / 1000).toFixed(1)}s</li></ul>
        </div>
      )}
    </div>
  );
}
