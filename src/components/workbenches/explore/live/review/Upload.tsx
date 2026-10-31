import { useRef, useState } from 'react';
import type { UploadBatch } from '../../../../../../packages/contracts/src/explore';
import type { ReviewApi, UploadHandle } from '../adapter';

// 上传区（10-explore-v2-contract.md 第 4.2 节）：先列不支持的文件和空间 → 开始；逐个和总字节进度、暂停、失败重试。
// 续传：批次 ID 记在本机；刷新后重新选同一批原文件，按 批次 + 文件名 + 大小 + 修改时间 接着传。

type Item = { key: string; file: File; sent: number; state: 'queued' | 'uploading' | 'paused' | 'done' | 'failed'; err?: string; h?: UploadHandle };
type Plan = { batch: UploadBatch; uploadUrl: string; space: { freeBytes: number; needBytes: number; ok: boolean } };
const keyOf = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;
const mb = (b: number) => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
const CONCURRENCY = 2;

export default function Upload({ api, dossierId, onUploaded }: { api: ReviewApi; dossierId: string; onUploaded: () => void }) {
  const store = `reinlab-upload:${dossierId}`;
  const [items, setItems] = useState<Item[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const live = useRef<Item[]>([]);
  const sync = () => setItems([...live.current]);
  const remembered = (() => { try { return JSON.parse(localStorage.getItem(store) ?? 'null') as { batchId: string; uploadUrl: string; keys: string[] } | null; } catch { return null; } })();

  const choose = async (list: FileList | File[]) => {
    setErr(null);
    const files = [...list].filter(f => !f.name.startsWith('.'));
    if (!files.length) return;
    try {
      // 和上次没传完的同一批文件：沿用原批次，tus 按指纹接着传
      const keys = files.map(keyOf);
      let p: Plan;
      if (remembered && keys.every(k => remembered.keys.includes(k))) {
        const batch = await api.batch(remembered.batchId);
        p = { batch, uploadUrl: remembered.uploadUrl, space: { freeBytes: 0, needBytes: 0, ok: true } };
      } else {
        p = await api.createBatch(files.map(f => ({ name: f.name, bytes: f.size, lastModified: f.lastModified })));
        localStorage.setItem(store, JSON.stringify({ batchId: p.batch.id, uploadUrl: p.uploadUrl, keys }));
      }
      const bad = new Set(p.batch.unsupported.map(u => u.fileName));
      live.current = files.filter(f => !bad.has(f.name)).map(f => ({ key: keyOf(f), file: f, sent: 0, state: 'queued' }));
      setPlan(p); sync();
    } catch (e) { setErr(e instanceof Error ? e.message : '建不了上传批次'); }
  };

  const pump = () => {
    if (!plan) return;
    const running = live.current.filter(i => i.state === 'uploading').length;
    for (const it of live.current.filter(i => i.state === 'queued').slice(0, Math.max(0, CONCURRENCY - running))) {
      it.state = 'uploading';
      it.h = api.upload(it.file, plan.batch.id, plan.uploadUrl, {
        progress: sent => { it.sent = sent; sync(); },
        done: () => { it.state = 'done'; it.sent = it.file.size; sync(); onUploaded(); pump(); if (live.current.every(i => i.state === 'done')) localStorage.removeItem(store); },
        error: m => { it.state = 'failed'; it.err = m; sync(); pump(); },
      });
      it.h.start();
    }
    sync();
  };
  const pauseAll = () => { for (const i of live.current) if (i.state === 'uploading' || i.state === 'queued') { i.h?.pause(); i.state = 'paused'; } sync(); };
  const resumeAll = () => { for (const i of live.current) if (i.state === 'paused' || i.state === 'failed') { i.state = 'queued'; i.err = undefined; } pump(); };

  const total = items.reduce((a, i) => a + i.file.size, 0), sent = items.reduce((a, i) => a + i.sent, 0);
  const counts = { done: items.filter(i => i.state === 'done').length, failed: items.filter(i => i.state === 'failed').length, active: items.some(i => i.state === 'uploading') };
  const started = items.some(i => i.state !== 'queued');

  return <div className="exr-upload" data-drag={drag || undefined}
    onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
    onDrop={e => { e.preventDefault(); setDrag(false); void choose(e.dataTransfer.files); }}>
    {!plan ? <>
      <p>把这次拍的 JPG 原图拖进来（整个文件夹也行），或者
        <label className="rh-btn">选文件<input type="file" multiple accept="image/jpeg,.jpg,.jpeg" hidden onChange={e => e.target.files && void choose(e.target.files)} /></label>
        <label className="rh-btn">选文件夹<input type="file" multiple hidden {...{ webkitdirectory: '' }} onChange={e => e.target.files && void choose(e.target.files)} /></label></p>
      {remembered && <p className="exr-hint">上次有一批没传完。刷新后浏览器拿不到原文件了：请重新选择同一批原文件，会接着传。</p>}
    </> : <>
      <div className="exr-upload-head">
        <b>{items.length} 张 · {mb(total)}</b>
        <span>{counts.done}/{items.length} 完成{counts.failed ? ` · ${counts.failed} 张失败` : ''}</span>
        <progress max={total || 1} value={sent} />
        {!started ? (plan.space.ok ? <button className="rh-btn is-solid" onClick={pump}>开始上传</button> : null)
          : counts.active ? <button className="rh-btn" onClick={pauseAll}>暂停</button>
          : counts.done < items.length ? <button className="rh-btn" onClick={resumeAll}>{counts.failed ? '重试失败的' : '继续'}</button>
          : <button className="rh-btn" onClick={() => { setPlan(null); live.current = []; sync(); }}>再传一批</button>}
      </div>
      {!plan.space.ok && <p className="exr-warn">空间不够：这批要 {mb(plan.space.needBytes)}，ReinLab 这边只剩 {mb(plan.space.freeBytes)}。先清理再传。</p>}
      {plan.batch.unsupported.length > 0 && <details className="exr-unsup"><summary>{plan.batch.unsupported.length} 个文件不收</summary>
        <ul>{plan.batch.unsupported.map(u => <li key={u.fileName}>{u.fileName} · {u.reason}</li>)}</ul></details>}
      <ul className="exr-files">{items.map(i => <li key={i.key} data-state={i.state}>
        <span>{i.file.name}</span><progress max={i.file.size} value={i.sent} />
        <small>{i.state === 'done' ? '完成' : i.state === 'failed' ? `失败：${i.err}` : i.state === 'paused' ? '已暂停' : i.state === 'uploading' ? `${Math.round(i.sent / i.file.size * 100)}%` : '等待'}</small>
      </li>)}</ul>
    </>}
    {err && <p className="exr-warn">{err}</p>}
  </div>;
}
