// 本地内存版回顾：只为看界面。示例照片是画出来的色块（标明"示例"），上传的文件只在本页内存里，不读 EXIF。
import type { CameraGroup, Comparison, ExplorePlan, Photo, Travelogue, UploadBatch } from '../../../../../packages/contracts/src/explore';
import { ExploreError, type ActualItem, type ReviewApi } from './adapter';

const swatch = (label: string, hue: number) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="hsl(${hue},35%,62%)"/><rect y="120" width="300" height="80" fill="hsl(${hue},30%,40%)"/><text x="12" y="28" font-family="sans-serif" font-size="18" fill="#fff">示例 · ${label}</text></svg>`);

export function createMemoryReview(plan: () => ExplorePlan, emit: (part: 'comparison' | 'travelogue' | 'picks' | 'photos' | 'clock') => void): ReviewApi {
  const day = plan().days[0] ?? new Date().toISOString().slice(0, 10);
  const at = (hhmm: string) => `${day}T${hhmm}:00+08:00`;
  const mk = (i: number, stopId: string | null, hhmm: string, basis: Photo['placement']['basis'], mark: Photo['ai']['mark'], group: string): Photo => ({
    id: `p${i}`, batchId: 'b0', fileName: `DSC0${1200 + i}.JPG`, bytes: 18_000_000, sha256: '', status: 'ready',
    exif: { dateTimeOriginal: `${day.replace(/-/g, ':')} ${hhmm}:00`, offset: group === 'g1' ? '+08:00' : null, subSec: null, gpsTime: null, gps: null,
      body: group === 'g1' ? 'ILCE-7CM2' : 'X100V', lens: group === 'g1' ? 'FE 85mm F1.8' : null, focalMm: group === 'g1' ? 85 : 23, aperture: 1.8, shutterS: 1 / 250, iso: 400, orientation: 1 },
    cameraGroupId: group,
    time: group === 'g1' ? { corrected: at(hhmm), basis: 'offset_tag', trust: 'certain' } : { corrected: null, basis: 'unknown', trust: 'pending' },
    placement: { stopId, basis, at: null },
    ai: { mark, reason: mark === 'recommend' ? '逆光轮廓清楚，人物在左三分之一，眼神到位' : mark === 'alternate' ? '构图好，但手的位置有点僵' : undefined, inspected: mark ? 'detail' : 'preview' },
    picked: i === 1, thumb: swatch(`DSC0${1200 + i}`, 20 + i * 23), preview: swatch(`DSC0${1200 + i}`, 20 + i * 23),
  });
  const photos: Photo[] = [
    mk(1, 's1', '16:42', 'event', 'recommend', 'g1'), mk(2, 's1', '16:44', 'event', 'alternate', 'g1'), mk(3, 's1', '16:51', 'plan_time', null, 'g1'),
    mk(4, 's1', '17:05', 'plan_time', 'recommend', 'g1'), mk(5, null, '18:20', 'unplanned', null, 'g1'),
    mk(6, null, '09:12', 'pending', null, 'g2'), mk(7, null, '09:14', 'pending', null, 'g2'),
  ];
  const groups: CameraGroup[] = [
    { id: 'g1', label: 'Sony ILCE-7CM2', photos: 5, timezone: 'Asia/Shanghai', timezoneBasis: 'offset_tag', offsetSec: 0, residualSec: 12, status: 'auto', anchors: [] },
    { id: 'g2', label: 'Fujifilm X100V', photos: 2, timezone: null, timezoneBasis: null, offsetSec: null, residualSec: null, status: 'needs_anchor', anchors: [],
      suggestion: { photoId: 'p6', eventClientId: 'e1', note: '这张和 16:40 的"到了 · 外滩观景平台"像是同一时刻' } },
  ];
  let travelogue: Travelogue | null = { id: 't1', revision: 1, updatedAt: new Date().toISOString(), photoIds: ['p1', 'p4'], sources: [],
    markdown: `## 外滩，日落前后\n\n16:40 到观景平台，比计划晚 10 分钟。风大，人比想的多。\n\n- 逆光那组最好（DSC01201）\n- 蓝调时刻云太厚，没等到\n\n（本地预览示例，不是真实游记）` };
  const comparison: Comparison = { revisionUsed: plan().revision, unplannedPhotoIds: ['p5'], items: plan().stops.map((s, i) => ({
    stopId: s.id, stopName: s.name, evidence: i === 0 ? 'shot' : i === 1 ? 'arrived_only' : 'none_found',
    plannedStart: s.window?.start ?? null, actualStart: i === 0 ? at('16:40') : null, lateMin: i === 0 ? 10 : null,
    light: i === 0 ? '日落前有直射光，蓝调被云挡' : null, notes: i === 0 ? ['风大，人多'] : [], photoIds: i === 0 ? ['p1', 'p2', 'p3', 'p4'] : [] })) };
  const batches = new Map<string, UploadBatch>();
  let n = 100;

  return {
    async createBatch(files) {
      const unsupported = files.filter(f => !/\.jpe?g$/i.test(f.name)).map(f => ({ fileName: f.name, reason: '不是 JPG（第一版只收 JPG）' }));
      const ok = files.filter(f => /\.jpe?g$/i.test(f.name));
      const batch: UploadBatch = { id: 'b' + (++n), createdAt: new Date().toISOString(), files: ok.length, bytes: ok.reduce((a, f) => a + f.bytes, 0), uploaded: 0, processed: 0, failed: 0, unsupported };
      batches.set(batch.id, batch);
      return { batch, uploadUrl: '/memory/uploads/', space: { freeBytes: 20e9, needBytes: batch.bytes, ok: true } };
    },
    async batch(id) { const b = batches.get(id); if (!b) throw new ExploreError('没有这个批次', 'NOT_FOUND'); return { ...b }; },
    upload(file, batchId, _url, on) {
      let sent = 0, timer = 0;
      const tick = () => {
        sent = Math.min(file.size, sent + Math.max(file.size / 8, 1));
        on.progress(sent, file.size);
        if (sent >= file.size) {
          window.clearInterval(timer);
          const url = URL.createObjectURL(file), i = ++n;
          photos.push({ ...mk(i, null, '12:00', 'pending', null, 'g2'), id: 'u' + i, batchId, fileName: file.name, bytes: file.size, thumb: url, preview: url, picked: false });
          const b = batches.get(batchId); if (b) { b.uploaded++; b.processed++; }
          on.done(); emit('photos');
        }
      };
      return { start() { window.clearInterval(timer); timer = window.setInterval(tick, 150); }, pause() { window.clearInterval(timer); }, abort() { window.clearInterval(timer); } };
    },
    async photos(q = {}) { return { items: photos.filter(p => !q.stopId || p.placement.stopId === q.stopId).map(p => ({ ...p })), cursor: null }; },
    async assign(ids, stopId) { for (const p of photos) if (ids.includes(p.id)) p.placement = { stopId, basis: stopId ? 'manual' : 'unplanned', at: p.placement.at }; emit('photos'); },
    async pick(ids, picked) { for (const p of photos) if (ids.includes(p.id)) p.picked = picked; emit('picks'); },
    async remove(id) { const i = photos.findIndex(p => p.id === id); if (i >= 0) photos.splice(i, 1); emit('photos'); },
    async storage() { return { dossierBytes: photos.reduce((a, p) => a + p.bytes, 0), freeBytes: 20e9 }; },
    async clock() { return structuredClone(groups); },
    async anchor(g, a) { const x = groups.find(y => y.id === g); if (x) { x.anchors.push({ photoId: a.photoId, eventClientId: a.eventClientId, time: a.time, deltaSec: 7 * 3600 + 28 * 60 }); x.offsetSec = 7 * 3600 + 28 * 60; x.timezone = 'Asia/Shanghai'; x.timezoneBasis = 'plan'; x.residualSec = 0; } emit('clock'); },
    async confirmClock(g, timezone, offsetSec) {
      const x = groups.find(y => y.id === g); if (!x) return;
      Object.assign(x, { status: 'confirmed', timezone, offsetSec, timezoneBasis: 'user' });
      for (const p of photos) if (p.cameraGroupId === g && p.placement.basis !== 'manual') {
        p.time = { corrected: at(p.id === 'p6' ? '16:40' : '16:42'), basis: 'clock_fix', trust: 'estimated' };
        p.placement = { stopId: 's1', basis: 'plan_time', at: null };
      }
      emit('clock'); emit('photos');
    },
    async split() { throw new ExploreError('本地预览不做拆组', 'NOT_AVAILABLE'); },
    async actual(): Promise<ActualItem[]> {
      const byStop = new Map<string, Photo[]>();
      for (const p of photos) if (p.time.corrected) { const k = p.placement.stopId ?? '~'; byStop.set(k, [...(byStop.get(k) ?? []), p]); }
      const clusters: ActualItem[] = [...byStop].map(([k, ps]) => {
        const ts = ps.map(p => p.time.corrected!).sort();
        return { type: 'cluster', stopId: k === '~' ? null : k, start: ts[0], end: ts[ts.length - 1], photoIds: ps.map(p => p.id), basis: ps[0].placement.basis };
      });
      return [{ type: 'event', record: { clientId: 'e1', kind: 'arrived', stopId: 's1', stopName: '外滩观景平台', planRevision: plan().revision, at: at('16:40'), tz: 'Asia/Shanghai', serverId: 'se1', receivedAt: at('16:40'), status: 'ok' } }, ...clusters];
    },
    async get() { return { comparison: structuredClone(comparison), travelogue: travelogue && { ...travelogue } }; },
    async saveTravelogue(base, markdown) {
      if (!travelogue || base !== travelogue.revision) throw new ExploreError('游记刚被改过', 'REVISION_CONFLICT');
      travelogue = { ...travelogue, markdown, revision: travelogue.revision + 1, updatedAt: new Date().toISOString() }; emit('travelogue'); return { ...travelogue };
    },
    exportUrl(f) { return 'data:text/plain;charset=utf-8,' + encodeURIComponent(f === 'md' ? travelogue?.markdown ?? '' : `<pre>${travelogue?.markdown ?? ''}</pre>`); },
    media: s => s,
    cropUrl: pid => photos.find(p => p.id === pid)?.preview ?? '',
  };
}
