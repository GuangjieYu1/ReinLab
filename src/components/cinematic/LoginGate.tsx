import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { CinematicBrand, RhineMark } from './BootStage';

export default function LoginGate({ onLogin, reduced, music, onMusicChange }: {
  onLogin: (identity: string) => void; reduced: boolean; music: boolean; onMusicChange: (value: boolean) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [introduced, setIntroduced] = useState(reduced);
  const [skipped, setSkipped] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const emblemRef = useRef<HTMLDivElement>(null);
  const entranceDone = introduced || reduced || skipped;
  useLayoutEffect(() => {
    const emblem = emblemRef.current;
    if (!emblem) return;
    // Measure only the untransformed layout once per resize, never in the frame loop.
    const composition = emblem.parentElement!;
    const place = () => {
      const container = composition.getBoundingClientRect();
      const x = container.left + emblem.offsetLeft + emblem.offsetWidth / 2;
      const y = container.top + emblem.offsetTop + emblem.offsetHeight / 2;
      emblem.style.setProperty('--intro-x', `${innerWidth / 2 - x}px`);
      emblem.style.setProperty('--intro-y', `${innerHeight * .48 - y}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(composition);
    return () => observer.disconnect();
  }, []);
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !entranceDone) return;
    // Never read, save, log, or transmit the password. This is only a local UI demonstration.
    const identity = formRef.current?.querySelector<HTMLInputElement>('[name="researcher-alias"]')?.value.trim().slice(0, 26) || 'LOCAL RESEARCHER';
    formRef.current?.reset();
    setSubmitting(true);
    onLogin(identity);
  }
  return <section className={`cine-login login-sequence ${submitting ? 'submitting' : ''} ${reduced ? 'no-motion' : ''} ${skipped ? 'intro-skipped' : ''}`}
    data-entry-phase={entranceDone ? 'login' : 'intro'} aria-label="演示登录">
    {!entranceDone && <button className="login-skip-intro" type="button" onClick={() => setSkipped(true)}>跳过入场 <ArrowRight size={13} /></button>}
    <div className="login-entry-caption" aria-hidden="true"><span>RHINE LAB.LLC.</span><span>INITIALIZING PERSONAL TERMINAL</span></div>
    <div className="login-brand"><CinematicBrand /></div>
    <div className="login-corner">IDENTITY ACCESS / PERSONAL TERMINAL</div>
    <div className="login-composition">
      <div className="login-emblem" ref={emblemRef}><RhineMark /><span>RESEARCH BEGINS WITH CURIOSITY.</span></div>
      <form className="login-form" ref={formRef} onSubmit={submit} autoComplete="off" inert={!entranceDone} aria-hidden={!entranceDone}
        onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === 'login-form-unfold') setIntroduced(true); }}>
        <div className="login-form-heading"><span>▪</span><div><h1>LOG IN</h1><p>IDENTITY VERIFICATION</p></div><span className="login-plus">+</span></div>
        <label className="login-field"><span>IDENTITY <small>研究员代号</small></span><input name="researcher-alias" aria-label="研究员代号" placeholder="LOCAL RESEARCHER" autoComplete="off" maxLength={40} spellCheck={false} /></label>
        <label className="login-field"><span>ACCESS KEY <small>接入密钥</small></span><span className="login-key-input"><input name="demonstration-key" aria-label="接入密钥" type={showKey ? 'text' : 'password'} placeholder="任意输入即可" autoComplete="off" data-lpignore="true" data-1p-ignore="true" /><button type="button" onClick={() => setShowKey(v => !v)} aria-label={showKey ? '隐藏接入密钥' : '显示接入密钥'}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></label>
        <div className="login-options"><label><input type="checkbox" checked={music} onChange={e => onMusicChange(e.target.checked)} />背景音乐</label><span>LOCAL ACCESS ONLY</span></div>
        <button className="login-submit" type="submit" disabled={submitting}><span>{submitting ? 'CONNECTING' : 'LOG IN'}</span><span>{submitting ? '正在接入' : '接入终端'}</span><ArrowRight size={18} /></button>
        <p className="login-demo-note">演示登录 · 任意内容均可进入 · 不保存或发送密钥</p>
      </form>
    </div>
    <div className="login-footer"><span>POWERED BY <b>RHINE LAB</b><i /></span><span>RHINE LAB.LLC. / INTERNAL DATABASE</span></div>
    <span className="cine-sr-status" role="status">{entranceDone ? '登录界面已就绪' : '终端入场中，随后显示登录界面'}</span>
  </section>;
}
