import { useState } from 'react';
import type { Platform } from '../model';
import TiltedCard from './reactbits/TiltedCard';

export function BrandMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'brand-mark small' : 'brand-mark'} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M17 44V25a11 11 0 0 1 22 0v14a8 8 0 0 0 16 0M8 33h40M28 11v43" stroke="currentColor" strokeWidth="2.3" />
    <circle cx="48" cy="33" r="3.5" fill="currentColor" />
    <path d="M10 49h9m-4.5-4.5v9" stroke="currentColor" strokeWidth="1.5" />
  </svg>;
}

export function PlatformArt({ kind }: { kind: Platform }) {
  return <svg viewBox="0 0 180 94" className={`platform-art ${kind}`} fill="none" aria-hidden="true">
    {kind === 'research' && <>
      <ellipse cx="90" cy="47" rx="55" ry="21" transform="rotate(-34 90 47)" />
      <ellipse cx="90" cy="47" rx="55" ry="21" transform="rotate(34 90 47)" />
      <ellipse cx="90" cy="47" rx="21" ry="43" />
      <circle cx="90" cy="47" r="8" className="art-fill" />
      <circle cx="127" cy="18" r="4" className="art-accent" />
      <path d="M15 47h22m106 0h22M90 2v8m0 74v8" strokeDasharray="2 3" />
    </>}
    {kind === 'learning' && <>
      <path d="M32 64L90 89l58-25-58-25zM32 48l58 25 58-25-58-25z" className="art-faint" />
      <path d="M32 31L90 56l58-25L90 6z" className="art-surface" />
      <path d="M32 31v12l58 25 58-25V31M90 56v12M90 6v19m-30 6h60" />
      <path d="M75 31l15-7 15 7-15 7z" className="art-accent" />
      <path d="M22 24v50m136-50v50" strokeDasharray="2 4" className="art-faint" />
    </>}
    {kind === 'engineering' && <>
      <path d="M38 30L70 12l32 18v36L70 84 38 66zM38 30l32 18 32-18M70 48v36" />
      <path d="M80 27l31-18 32 18v37l-32 18-31-18zM80 27l31 18 32-18M111 45v37" className="art-faint" />
      <path d="M70 12v20l-16 9M70 32l16 9" className="art-accent-stroke" />
      <circle cx="111" cy="45" r="4" className="art-accent" />
    </>}
    {kind === 'travel' && <>
      <circle cx="90" cy="47" r="38" />
      <ellipse cx="90" cy="47" rx="17" ry="38" transform="rotate(20 90 47)" />
      <ellipse cx="90" cy="47" rx="38" ry="15" transform="rotate(20 90 47)" />
      <path d="M51 34c-29 0-22 36 33 42s95-29 61-42" strokeDasharray="3 4" />
      <circle cx="124" cy="31" r="4" className="art-accent" />
      <path d="M90 1v8m0 76v8M44 47h8m76 0h8" />
    </>}
  </svg>;
}

export function ArchiveObject({ reduced = false }: { reduced?: boolean }) {
  return <div className="archive-scene" aria-label="由 CSS 透视构成的双环档案装置">
    <div className="scene-cross cross-a">+</div><div className="scene-cross cross-b">+</div>
    <div className="scene-orbit orbit-one" /><div className="scene-orbit orbit-two" />
    <span className="scene-label label-top">OPTICAL ARCHIVE<br /><b>RL / 024—A</b></span>
    <span className="scene-label label-bottom">KNOWLEDGE CORE<br />ARCHIVE READY <i /></span>
    <div className="archive-shadow" />
    <div className="archive-stack">
      <div className="archive-plate plate-back"><span>REINLAB / 002</span></div>
      <div className="archive-plate plate-middle"><span>REINLAB / 001</span></div>
      <div className="archive-top">
        <TiltedCard imageSrc="/archive.svg" altText="莱茵档案，暖灰磨砂外壳中的双环光学结构"
          containerHeight="100%" containerWidth="100%" imageHeight="100%" imageWidth="100%"
          rotateAmplitude={reduced ? 0 : 6} scaleOnHover={1} showMobileWarning={false} showTooltip={false} />
      </div>
    </div>
    <div className="scene-scale">{Array.from({ length: 21 }, (_, i) => <i key={i} />)}</div>
  </div>;
}

export function EigenDiagram({ compact = false, value: controlled, onChange }: { compact?: boolean; value?: number; onChange?: (value: number) => void }) {
  const [internalValue, setInternalValue] = useState(1.8);
  const value = controlled ?? internalValue;
  const setValue = onChange ?? setInternalValue;
  const endX = 165 + value * 55;
  return <div className={`eigen-demo ${compact ? 'compact' : ''}`}>
    <div className="diagram-head"><span>交互实验 / 01</span><span>A = diag({value.toFixed(1)}, 1)</span></div>
    <svg viewBox="0 0 500 204" role="img" aria-label={`水平方向拉伸 ${value.toFixed(1)} 倍，竖直方向保持不变`}>
      <defs><pattern id="eigen-grid" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="#a9b09b" strokeWidth=".5" opacity=".4" /></pattern></defs>
      <rect x="20" y="8" width="460" height="180" fill="url(#eigen-grid)" />
      <path d="M40 150H470M165 187V18" stroke="#a1a694" strokeWidth="1" />
      <path d="M165 95h55v55h-55z" fill="#78876a" fillOpacity=".08" stroke="#829473" strokeDasharray="4 4" />
      <path d={`M165 95h${value * 55}v55H165z`} fill="#b89b65" fillOpacity=".13" stroke="#b09661" />
      <path d={`M165 150H${endX}m-8-5 8 5-8 5`} stroke="#a8884c" strokeWidth="2.5" fill="none" />
      <path d="M165 150V95m-5 8 5-8 5 8" stroke="#637359" strokeWidth="2.5" fill="none" />
      <circle cx="165" cy="150" r="3.5" fill="#343e32" />
      <text x={endX + 10} y="156" fill="#8a713d" fontSize="13">λv</text>
      <text x="175" y="86" fill="#657358" fontSize="13">v₂</text>
      <text x="146" y="168" fill="#858b7f" fontSize="11">O</text>
      <text x="341" y="35" fill="#8a907f" fontSize="10" letterSpacing="1.5">LINEAR TRANSFORMATION</text>
      <text x="341" y="56" fill="#56634f" fontSize="12">方向不变，尺度改变。</text>
    </svg>
    <label className="range-label"><span>拖动以改变特征值 <b>λ = {value.toFixed(1)}</b></span>
      <input aria-label="特征值" type="range" min=".4" max="3.5" step=".1" value={value} onChange={e => setValue(Number(e.target.value))} />
      <span className="range-limits"><span>压缩 · 0.4</span><span>拉伸 · 3.5</span></span>
    </label>
  </div>;
}
