import { useEffect, useId, useRef, useState } from 'react';
import { contactNames } from '../learningState';
import type { SceneProps } from './types';

const times = [.12, .87, 1.62, 2.37];
function GuitarScore({ beat, seek }: { beat: number; seek: (i: number) => void }) {
  return <div className="guitar-score" aria-label="四拍吉他六线谱">
    <div className="guitar-strings" aria-hidden="true">{['e', 'B', 'G', 'D', 'A', 'E'].map(s => <span key={s}>{s}</span>)}</div>
    {[0, 3, 8, 3].map((fret, i) => <button key={i} aria-label={`定位第 ${i + 1} 拍`} aria-pressed={beat === i + 1} onClick={() => seek(i)}><span className="guitar-fret">{fret}</span><span className="guitar-score-lines" aria-hidden="true" /><small>第 {i + 1} 拍</small></button>)}
  </div>;
}
export function GuitarLesson({ scene: s, change, onMediaPlaying }: SceneProps) {
  const video = useRef<HTMLVideoElement>(null);
  const audios = useRef<(HTMLAudioElement | null)[]>([]);
  const [beat, setBeat] = useState(s.beat);
  const [speed, setSpeed] = useState(1);
  const [error, setError] = useState('');
  const savedTime = useRef(s.videoTime); savedTime.current = s.videoTime;
  const latest = useRef({ change, onMediaPlaying }); latest.current = { change, onMediaPlaying };
  useEffect(() => () => { latest.current.onMediaPlaying?.(false); }, []);
  useEffect(() => { onMediaPlaying?.(false); }, [s.stage, onMediaPlaying]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) { video.current?.pause(); audios.current.forEach(a => a?.pause()); } };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  useEffect(() => {
    const v = video.current;
    if (v && Number.isFinite(v.duration) && Math.abs(v.currentTime - s.videoTime) > .4) v.currentTime = s.videoTime;
  }, [s.videoTime, s.stage]);
  function seek(index: number) {
    if (video.current) video.current.currentTime = times[index];
    setBeat(index + 1); change({ videoTime: times[index], beat: index + 1 }, true);
  }
  function pause() {
    onMediaPlaying?.(false);
    const v = video.current; if (v) change({ videoTime: Math.min(10, v.currentTime), beat });
  }
  if (s.stage) return <section><span className="rl-label">节拍听辨 / 两段原创合成音，不启用麦克风</span><h3>哪个音，稍晚进入了？</h3><p className="media-intro">先听 A，再听 B。两段的音高相同，B 中有一个音延迟了约 0.20 秒。</p><div className="rl-listen">{['A / 均匀进入', 'B / 听辨素材'].map((title, i) => <div key={i}><label>{title}<audio aria-label={`播放示范 ${i ? 'B' : 'A'}`} controls preload="metadata" ref={el => { audios.current[i] = el; }} src={`/classroom/guitar-${i ? 'b' : 'a'}.wav`} onLoadedMetadata={e => { e.currentTarget.currentTime = s.audioTimes[i]; }} onPlay={() => { audios.current.forEach((a, j) => { if (j !== i) a?.pause(); }); onMediaPlaying?.(true); }} onPause={e => { const audioTimes: [number, number] = [...s.audioTimes]; audioTimes[i] = Math.min(10, e.currentTarget.currentTime); change({ audioTimes }); if (!audios.current.some(a => a && !a.paused)) onMediaPlaying?.(false); }} onEnded={() => onMediaPlaying?.(false)} onError={() => setError('音频暂时不可播放，请重新打开这份课堂。')} /></label></div>)}</div><div className="rl-beats">{[1, 2, 3, 4].map(i => <button key={i} aria-pressed={s.beat === i} onClick={() => change({ beat: i }, true)}>第 {i} 拍<small>标记差异</small></button>)}</div><p className="rl-result" role="status">{s.beat ? s.beat === 4 ? '本例第 4 拍的进入较晚。这个听辨结果不代表真实演奏评估。' : '再听最后一个音的进入时刻。本例差异在第 4 拍。' : '未选择；这里只核对预先设定的听辨样例。'}</p>{error && <p role="alert">{error}</p>}</section>;
  return <section><div className="rl-video"><video ref={video} controls playsInline preload="metadata" aria-label="四拍指板演示视频" src="/classroom/guitar-four-beats.mp4" onLoadedMetadata={e => { e.currentTarget.currentTime = savedTime.current; e.currentTarget.playbackRate = speed; }} onPlay={() => onMediaPlaying?.(true)} onPause={pause} onEnded={pause} onError={() => setError('示意视频暂时不可播放；下方谱面仍可使用。')} onTimeUpdate={e => {
    const t = e.currentTarget.currentTime;
    const b = t < .12 ? 0 : Math.min(4, Math.floor((t - .12) / .75) + 1);
    setBeat(b); change({ videoTime: Math.min(10, t), beat: b });
  }} /><div className="rl-video-meta"><span>四个音，一句旋律</span><span>原创指板示意＋合成音 · 非实拍</span></div></div><div className="rl-controls"><label>播放速度<select aria-label="视频播放速度" value={speed} onChange={e => { const v = Number(e.target.value); setSpeed(v); if (video.current) video.current.playbackRate = v; }}><option value=".5">0.5×</option><option value=".75">0.75×</option><option value="1">1×</option></select></label><span className="rl-label">标准调弦 · 第一弦 0 / 3 / 8 / 3 品 · 原速 ♩ = 80</span></div><GuitarScore beat={beat} seek={seek} /><p className="rl-result">点击谱面定位视频；课程媒体播放时，背景音乐会降低音量。</p>{error && <p role="alert">{error}</p>}</section>;
}

function Portrait() {
  const id = useId().replace(/:/g, '');
  return <svg viewBox="0 0 240 300" role="img" aria-label="矢量布光人像示意，非实拍作品"><defs>
    <linearGradient id={`${id}-bg`} x2="1" y2=".2"><stop stopColor="#7c8b7e" /><stop offset="1" stopColor="#d5cfbd" /></linearGradient>
    <linearGradient id={`${id}-skin`} x2="1" y2=".4"><stop stopColor="#d8c7ab" /><stop offset=".55" stopColor="#b29f82" /><stop offset="1" stopColor="#737969" /></linearGradient>
    <linearGradient id={`${id}-coat`} x2=".8" y2=".3"><stop stopColor="#c9cabe" /><stop offset="1" stopColor="#69796d" /></linearGradient>
  </defs><rect width="240" height="300" fill={`url(#${id}-bg)`} /><path d="M-30 0H60L110 300H-30Z" fill="#f5ead4" opacity=".25" /><path d="M42 310Q42 211 83 202L94 181H142L152 200Q204 211 219 310Z" fill={`url(#${id}-coat)`} /><path d="M98 169L95 207Q120 224 143 202L137 165Z" fill={`url(#${id}-skin)`} /><path d="M80 105Q72 51 114 49Q158 43 162 94L153 150Q140 178 119 181Q91 172 83 143Z" fill={`url(#${id}-skin)`} /><path d="M78 126Q64 76 87 50Q119 25 150 52Q168 65 163 111L151 90Q142 92 134 65Q108 91 87 93L86 130Z" fill="#475247" /><path d="M93 120Q100 116 107 120M130 119Q138 115 145 119" stroke="#62624f" fill="none" /><path d="M121 123L116 142L122 144M108 155Q122 160 134 153" stroke="#8b7f65" fill="none" /><path d="M88 204L117 233L149 201M117 233L124 300" stroke="#899383" fill="none" /></svg>;
}
export function PhotoLesson({ scene: s, change, record }: SceneProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rec = useRef(record); rec.current = record;
  const [notice, setNotice] = useState('');
  useEffect(() => () => clearTimeout(timer.current), []);
  if (s.stage) return <section><span className="rl-label">接触表 / 示意构图，不是六张真实照片</span><div className="rl-contact-sheet">{contactNames.map((name, i) => {
    const order = s.picks.indexOf(i);
    return <button key={name} className="rl-contact" aria-label={`选择作品 ${i + 1} ${name}`} aria-pressed={order >= 0} onClick={() => {
      if (order >= 0) change({ picks: s.picks.filter(p => p !== i) }, true);
      else if (s.picks.length < 3) change({ picks: [...s.picks, i] }, true);
      else { setNotice('先选三张。取消一张后，才能加入新的画面。'); return; }
      setNotice('');
    }}><span className="rl-contact-image" style={{ filter: `brightness(${[.91, 1, 1.06, 1.12, .88, .97][i]})` }}><span style={{ display: 'block', height: '100%', transform: `scale(${[.86, 1, 1.08, 1.6, 1.03, .94][i]}) scaleX(${i === 4 ? -1 : 1})`, transformOrigin: i === 3 ? '50% 32%' : '50% 50%' }}><Portrait /></span></span>{order >= 0 && <span className="rl-contact-order">{order + 1}</span>}<span>{String(i + 1).padStart(2, '0')} / {name}</span></button>;
  })}</div><div className="rl-sequence"><span className="rl-index">组照顺序 / 按选择次序排列</span>{s.picks.length ? s.picks.map((i, n) => `${n + 1}. ${contactNames[i]}`).join(' → ') : '从一张开场开始。'}<div className="rl-controls"><button disabled={s.picks.length < 2} onClick={() => change({ picks: [...s.picks].reverse() }, true)}>反转顺序</button><button disabled={!s.picks.length} onClick={() => change({ picks: [] }, true)}>清空选择</button></div></div><p className="rl-result" role="status">{notice || `已选 ${s.picks.length}/3。开场、靠近、收束：每一张在这组作品中承担什么作用？`}</p></section>;
  return <section><span className="rl-label">布光示意 / 对照讲评 · 非实拍作品</span><div className="rl-photo-pair"><div><div className="rl-photo-frame"><Portrait />{[1, 2].map(n => <button key={n} className="rl-hotspot" style={n === 1 ? { left: '49%', top: '35%' } : { left: '72%', top: '75%' }} aria-label={`照片批注 ${n}`} aria-pressed={s.point === n} onClick={() => change({ point: n }, true)}>{n}</button>)}</div><div className="rl-photo-caption">A / 原始示意 · 点击编号定位</div></div><div><div className="rl-photo-frame"><div style={{ filter: `brightness(${s.exposure / 100})`, height: '100%' }}><Portrait /></div>{s.grid && <div className="rl-photo-grid" />}</div><div className="rl-photo-caption">B / 修改预览 · 不覆盖 A</div></div></div><div className="rl-controls"><label>预览亮度<input aria-label="预览亮度" type="range" min="70" max="130" step="5" value={s.exposure} onChange={e => { change({ exposure: Number(e.target.value) }); clearTimeout(timer.current); timer.current = setTimeout(() => rec.current(), 500); }} /><span>{s.exposure}%</span></label><button aria-pressed={s.grid} onClick={() => change({ grid: !s.grid }, true)}>三分网格</button></div><p className="rl-result" role="status">批注 {s.point} / {s.point === 1 ? '面部与背景的亮度关系' : '肩部轮廓与画面边缘'}。亮度仅为视觉预览，不是曝光计算。</p></section>;
}
