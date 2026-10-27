import { ACTUAL, LOOKS, type Note, type Shot, type Spot } from './model';
import { hm } from './sun';
import KyotoMap from './KyotoMap';
import DayLine from './DayLine';
import { Photo, SCENE_OF } from './Figures';

// 回顾面：照片按拍摄位置落回地图，时间线上叠「实际」轨道对照计划；
// 右栏：精选（按机位分组、打星、挑片）· 观察（现场碎片 → 助手按主题整理 + 游记草稿）· 下次（经验写回计划）；
// 底部把结果交给其他工作台（都要你批准）。

export type Lesson = { id: string; spot: string; text: string; start?: number; rule?: string };
export const LESSONS: Lesson[] = [
  { id: 'L1', spot: 'P1', text: '东山挡光，这里见光比日出晚近一小时：下次 07:15 再开拍，前面的时间留给化妆。', start: 7 * 60 + 15 },
  { id: 'L2', spot: 'P3', text: '水路阁 10 点后团客一批接一批：下次 09:30 先拍水路阁。', start: 9 * 60 + 30 },
  { id: 'L3', spot: 'P4', text: '14 点前后常有阵雨：下次把铁道挪到 12:40，饭后再去。', start: 12 * 60 + 40 },
  { id: 'L4', spot: 'P6', text: '白川南通有一段是私道：机位固定在巽桥的公共道路段。', rule: '机位固定在巽桥公共道路段（白川南通部分为私道）' },
];
const THEMES: Record<Note['tag'], string> = {
  光线: '东山让早晨的直射光推迟到 07:18；傍晚灯笼 17:15 亮，蓝调只有十分钟左右，要提前站好位。',
  人流: '银阁寺和水路阁都是 9 点后团客明显增多，空档大约两三分钟一次。',
  服饰: 'A 米白在逆光里透光最好；B 藏青在红砖前很稳；C 的橙色围巾在夜里最跳——三套都对。',
  天气: '14:00 的阵雨和预报一致，备选的疏水纪念馆可用。',
  规定: '祇园白川南通有私道告示，按公共道路拍，没有起冲突。',
  机位: '疏水纪念馆的砖拱可以当水路阁的「室内版」，以后雨天都可以用。',
};
export const DIARY = '早上六点半出门，东山还挡着太阳，在哲学之道等了十几分钟，第一束光从第三棵枫树后面穿过来，米白开衫一下子亮了。银阁寺赶在团客前拍完向月台。水路阁人多，就在拱下一批一批地等空档。午后果然下了阵雨，临时转去疏水纪念馆，砖拱在室内反而更安静。傍晚到白川时灯笼刚亮，橙色围巾和灯笼在蓝调里互相呼应，这一天的颜色在这里收住了。';

export default function ReviewFace({ spots, shots, onPick, notes, organized, onOrganize, tab, onTab, lessons, onLesson, handed, onHand, t, onT, sel, onSel, onOpenShot, busy }: {
  spots: Spot[]; shots: Shot[]; onPick: (id: string) => void; notes: Note[]; organized: boolean; onOrganize: () => void;
  tab: 'picks' | 'notes' | 'next'; onTab: (t: 'picks' | 'notes' | 'next') => void; lessons: string[]; onLesson: (l: Lesson) => void;
  handed: string[]; onHand: (k: 'creative' | 'research' | 'automation') => void; t: number; onT: (t: number) => void; sel: string; onSel: (id: string) => void; onOpenShot: (s: Shot) => void; busy: boolean;
}) {
  const picks = shots.filter(s => s.pick), order = [...spots].sort((a, b) => a.start - b.start);
  const groups = [...order.map(s => ({ id: s.id, name: `${s.no} ${s.name}`, list: shots.filter(x => x.spot === s.id) })), { id: 'backup', name: '雨天备选 · 疏水纪念馆', list: shots.filter(x => x.spot === 'backup') }].filter(g => g.list.length);
  const hit = order.filter(s => ACTUAL[s.id]).length;
  return <div className="ex-center ex-review">
    <header className="ex-head">
      <span className="ex-id">回顾</span>
      <div className="ex-title"><strong>东山 · 秋日人像 · 拍完了</strong><span>{shots.length} 张 <i>·</i> 精选 {picks.length} <i>·</i> 计划机位 {hit} / {spots.length} 拍到 <i>·</i> 现场记录 {notes.length} 条</span></div>
      <button className="ex-go" onClick={onOrganize} disabled={busy || organized}><i />{organized ? '已整理' : '整理观察'}</button>
    </header>
    <div className="ex-reviewbody">
      <div className="ex-rmap">
        <KyotoMap spots={spots} sel={sel} onSel={onSel} t={t} shots={shots} onShot={onOpenShot} done={Object.keys(ACTUAL).filter(k => ACTUAL[k])} />
        <DayLine spots={spots} sel={sel} onSel={onSel} t={t} onT={onT} actual={ACTUAL} compact />
      </div>
      <aside className="ex-rside">
        <div className="ex-tabs" role="tablist">{([['picks', `精选 ${picks.length}`], ['notes', organized ? '观察 · 已整理' : `观察 ${notes.length}`], ['next', `下次 ${LESSONS.length - lessons.length}`]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>{l}</button>)}</div>
        {tab === 'picks' && <div className="ex-sheet">{groups.map(g => <section key={g.id}><h4>{g.name}<small>{g.list.length} 张</small></h4><div>{g.list.map(s => {
          const spot = spots.find(x => x.id === s.spot), look = LOOKS.find(l => l.id === (spot?.look ?? 'B'));
          return <figure key={s.id} data-pick={s.pick || undefined}><button onClick={() => onOpenShot(s)}><Photo seed={s.seed} scene={SCENE_OF[s.spot]} palette={look?.palette} person={!spot || spot.kind === 'portrait'} night={s.spot === 'P6' && s.at > 17 * 60} stamp={false} /></button>
            <figcaption><span>{'★'.repeat(s.rating)}{'☆'.repeat(3 - s.rating)}</span><time>{hm(s.at)}</time><button onClick={() => onPick(s.id)} aria-pressed={!!s.pick}>{s.pick ? '已选' : '选'}</button></figcaption></figure>; })}</div></section>)}</div>}
        {tab === 'notes' && <div className="ex-obs">
          {!organized ? <ol className="ex-notes is-raw">{notes.map((n, i) => <li key={i}><time>{hm(n.at)}</time><em>{n.tag}</em>{n.text}</li>)}</ol>
            : <>{(Object.keys(THEMES) as Note['tag'][]).filter(k => notes.some(n => n.tag === k)).map((k, i) => <section key={k} className="ex-theme" style={{ animationDelay: `${i * 80}ms` }}>
              <h4>{k}<small>{notes.filter(n => n.tag === k).length} 条</small></h4><p>{THEMES[k]}</p>
              <ul>{notes.filter(n => n.tag === k).map((n, j) => <li key={j}><time>{hm(n.at)}</time>{n.text}</li>)}</ul></section>)}
              <section className="ex-diary"><h4>游记草稿</h4><p>{DIARY}</p></section></>}
        </div>}
        {tab === 'next' && <ol className="ex-lessons">{LESSONS.map(l => <li key={l.id} data-done={lessons.includes(l.id) || undefined}>
          <b>{spots.find(s => s.id === l.spot)?.no}</b><p>{l.text}</p>
          <button className="rh-btn" onClick={() => onLesson(l)} disabled={lessons.includes(l.id)}>{lessons.includes(l.id) ? '已写回计划' : l.start ? `写回 · 改到 ${hm(l.start)}` : '写回 · 加到规定'}</button></li>)}</ol>}
        <footer className="ex-hand">
          <span className="rh-micro">交给其他工作台</span>
          <button onClick={() => onHand('creative')} data-done={handed.includes('creative') || undefined}><b>创作台</b><small>精选 {picks.length} 张 → 作品集《东山 · 秋日》</small></button>
          <button onClick={() => onHand('research')} data-done={handed.includes('research') || undefined} disabled={!organized}><b>研究台</b><small>{organized ? '观察笔记 → R—014' : '先整理观察'}</small></button>
          <button onClick={() => onHand('automation')} data-done={handed.includes('automation') || undefined}><b>自动化</b><small>照片按 GPS 归位 → WF-06</small></button>
        </footer>
      </aside>
    </div>
  </div>;
}
