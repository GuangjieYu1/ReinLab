export const LEARNING_KEY = 'reinlab-learning-classrooms-v1';
export const subjectIds = ['math', 'physics', 'systems', 'history', 'guitar', 'photo'] as const;
export type SubjectId = typeof subjectIds[number];
export const subjectInfo: Record<SubjectId, { name: string; title: string; code: string; stages: [string, string]; goal: string; note: string }> = {
  math: { name: '群论', title: '从对称，到群的语言', code: 'MATH / G–01', stages: ['讲义与模拟', 'AI 画布'], goal: '从操作的组合走向群的定义；区分结合律与交换律，并完成一个短证明。', note: '图形重合，不代表操作相同。\n我需要追踪每一个标记，而不只是轮廓。' },
  physics: { name: '模拟物理', title: '让预测成为实验', code: 'PHYSICS / P–01', stages: ['讲义与实验', '对照记录'], goal: '控制劲度系数，比较质量与周期；区分模型计算与真实测量。', note: '一次只改变一个条件。\n先记录预测，再保存结果。' },
  systems: { name: 'CSAPP', title: '看见程序的执行', code: 'SYSTEMS / C–01', stages: ['单步调试', '讲义与代码模拟'], goal: '联系代码、数组和局部状态，解释一次完整的累加过程。', note: '高亮表示下一条待执行的语句。\n我需要区分即将读取的值与已经累加的值。' },
  history: { name: '历史专题', title: '在地球上展开讨论', code: 'HISTORY / H–01', stages: ['区域与路径', '比较材料'], goal: '把地理定位、假设路径和历史证据分开记录。', note: '红线是空间批注，不自动等于确定的历史路线。\n每一条判断都需要对应来源。' },
  guitar: { name: '吉他', title: '跟着谱，回到那一拍', code: 'MUSIC / M–01', stages: ['视频与谱面', '片段听辨'], goal: '在演示视频与谱面之间定位同一个片段，分辨节拍差异。', note: '先关注一个可重复练习的片段。\n节拍、音色和表达是不同的反馈维度。' },
  photo: { name: '摄影', title: '从单张，到一组表达', code: 'IMAGE / I–01', stages: ['对照讲评', '选片与叙事'], goal: '让局部讲评对应具体画面，再选择一组有顺序的作品。', note: '先确定表达意图，再判断是否需要修改。\n“更亮”并不自动等于“更好”。' },
};
export type Point = [number, number];
export type Scene = {
  stage: 0 | 1; page: number; angle: 90 | 180; operation: 'RF' | 'FR'; proof: number; answer: string;
  canvasLayer: number; nodes: Point[]; selectedNode: number;
  mass: number; stiffness: number; time: number; step: number;
  lon: number; lat: number; zoom: number; route: boolean; strokes: Point[][]; judgments: string[];
  videoTime: number; beat: number; audioTimes: [number, number];
  exposure: number; grid: boolean; point: number; picks: number[];
};
export const freshScene = (): Scene => ({
  stage: 0, page: 0, angle: 90, operation: 'RF', proof: 0, answer: '', canvasLayer: 0,
  nodes: [[27, 27], [73, 27], [73, 69], [27, 69]], selectedNode: 0,
  mass: 1, stiffness: 10, time: 0, step: 0, lon: 10, lat: 24, zoom: 1, route: false, strokes: [], judgments: ['待判断', '待判断', '待判断'],
  videoTime: 0, beat: 0, audioTimes: [0, 0], exposure: 100, grid: true, point: 1, picks: [],
});
export type Evidence = { id: string; kind: 'snapshot' | 'student' | 'example'; text: string; at: number; scene: Scene };
export type LearningRecord = { note: string; noteVersions: string[]; draft: string; scene: Scene; evidence: Evidence[]; visited: number | null };
export type LearningStore = { version: 1; active: SubjectId; subjects: Record<SubjectId, LearningRecord>; largeType: boolean; notesWide: boolean };
export function freshLearning(): LearningStore {
  const make = (id: SubjectId): LearningRecord => ({ note: subjectInfo[id].note, noteVersions: [], draft: '', scene: freshScene(), evidence: [], visited: null });
  return { version: 1, active: 'math', largeType: false, notesWide: false, subjects: {
    math: make('math'), physics: make('physics'), systems: make('systems'), history: make('history'), guitar: make('guitar'), photo: make('photo'),
  } };
}
const numberIn = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const integerIn = (v: unknown, lo: number, hi: number) => numberIn(v, lo, hi) && Number.isInteger(v);
const point = (p: unknown, loX: number, hiX: number, loY: number, hiY: number): p is Point => Array.isArray(p) && p.length === 2 && numberIn(p[0], loX, hiX) && numberIn(p[1], loY, hiY);
export function isScene(value: unknown): value is Scene {
  if (!value || typeof value !== 'object') return false;
  const v = value as Scene;
  return [0, 1].includes(v.stage) && integerIn(v.page, 0, 5) && [90, 180].includes(v.angle) && ['RF', 'FR'].includes(v.operation)
    && integerIn(v.proof, 0, 3) && typeof v.answer === 'string' && v.answer.length < 200
    && integerIn(v.canvasLayer, 0, 3) && integerIn(v.selectedNode, 0, 3) && Array.isArray(v.nodes) && v.nodes.length === 4 && v.nodes.every(p => point(p, 10, 90, 10, 85))
    && numberIn(v.mass, .5, 2) && numberIn(v.stiffness, 10, 40) && numberIn(v.time, 0, 8) && integerIn(v.step, 0, 10)
    && numberIn(v.lon, -180, 180) && numberIn(v.lat, -75, 75) && numberIn(v.zoom, 1, 3)
    && typeof v.route === 'boolean' && Array.isArray(v.strokes) && v.strokes.length <= 10 && v.strokes.every(s => Array.isArray(s) && s.length <= 100 && s.every(p => point(p, -180, 180, -90, 90)))
    && Array.isArray(v.judgments) && v.judgments.length === 3 && v.judgments.every(s => ['待判断', '局部变化', '跨区域关联', '暂不足区分'].includes(s))
    && numberIn(v.videoTime, 0, 10) && integerIn(v.beat, 0, 4) && Array.isArray(v.audioTimes) && v.audioTimes.length === 2 && v.audioTimes.every(t => numberIn(t, 0, 10))
    && numberIn(v.exposure, 70, 130) && typeof v.grid === 'boolean' && [1, 2].includes(v.point) && Array.isArray(v.picks) && v.picks.length <= 3 && v.picks.every(p => integerIn(p, 0, 5)) && new Set(v.picks).size === v.picks.length;
}
export function isLearningStore(value: unknown): value is LearningStore {
  if (!value || typeof value !== 'object') return false;
  const v = value as LearningStore;
  return v.version === 1 && subjectIds.includes(v.active) && typeof v.largeType === 'boolean' && typeof v.notesWide === 'boolean'
    && !!v.subjects && subjectIds.every(id => {
      const s = v.subjects[id];
      return s && typeof s.note === 'string' && s.note.length <= 6000 && typeof s.draft === 'string' && s.draft.length <= 2000
        && Array.isArray(s.noteVersions) && s.noteVersions.length <= 12 && s.noteVersions.every(n => typeof n === 'string' && n.length <= 6000)
        && isScene(s.scene) && (s.visited === null || numberIn(s.visited, 0, Number.MAX_SAFE_INTEGER))
        && Array.isArray(s.evidence) && s.evidence.length <= 60 && s.evidence.every(e => e && typeof e.id === 'string' && e.id.length <= 100 && ['snapshot', 'student', 'example'].includes(e.kind) && typeof e.text === 'string' && e.text.length <= 2000 && numberIn(e.at, 0, Number.MAX_SAFE_INTEGER) && isScene(e.scene));
    });
}
export function updateScene(store: LearningStore, id: SubjectId, patch: Partial<Scene>): LearningStore {
  return { ...store, subjects: { ...store.subjects, [id]: { ...store.subjects[id], scene: { ...store.subjects[id].scene, ...patch } } } };
}
export function addEvidence(store: LearningStore, id: SubjectId, evidence: Evidence): LearningStore {
  const current = store.subjects[id];
  return { ...store, subjects: { ...store.subjects, [id]: { ...current, evidence: [...current.evidence, structuredClone(evidence)].slice(-60) } } };
}
export function restoreEvidence(store: LearningStore, id: SubjectId, evidenceId: string): LearningStore {
  const e = store.subjects[id].evidence.find(e => e.id === evidenceId);
  return e ? updateScene(store, id, structuredClone(e.scene)) : store;
}
export const period = (mass: number, stiffness: number) => 2 * Math.PI * Math.sqrt(mass / stiffness);
export const normalizeLongitude = (lon: number) => ((lon + 180) % 360 + 360) % 360 - 180;
export function transformPoint(p: Point, angle: 90 | 180, order: 'RF' | 'FR'): Point {
  const rotate = ([x, y]: Point): Point => angle === 90 ? [-y, x] : [-x, -y];
  const reflect = ([x, y]: Point): Point => [-x, y];
  return order === 'RF' ? reflect(rotate(p)) : rotate(reflect(p));
}
export const trace = [
  { line: 1, i: '—', sum: '—', read: -1, note: '准备初始化数组' },
  { line: 2, i: '—', sum: '—', read: -1, note: '数组已初始化' },
  { line: 3, i: '—', sum: '0', read: -1, note: 'sum 已初始化为 0' },
  { line: 4, i: '0', sum: '0', read: 0, note: '准备读取 a[0]' },
  { line: 3, i: '0', sum: '2', read: 0, note: '读取 2，累加后 sum = 2' },
  { line: 4, i: '1', sum: '2', read: 1, note: '准备读取 a[1]' },
  { line: 3, i: '1', sum: '5', read: 1, note: '读取 3，累加后 sum = 5' },
  { line: 4, i: '2', sum: '5', read: 2, note: '准备读取 a[2]' },
  { line: 3, i: '2', sum: '10', read: 2, note: '读取 5，累加后 sum = 10' },
  { line: 6, i: '已出作用域', sum: '10', read: -1, note: '循环结束，准备返回 sum' },
  { line: 0, i: '已出作用域', sum: '10', read: -1, note: '函数返回 10' },
];
export const contactNames = ['环境开场', '正面靠近', '侧向留白', '细节特写', '反向光线', '安静收束'];
export function describeScene(id: SubjectId, s: Scene): string {
  switch (id) {
    case 'math': {
      if (s.stage) return `绘图流程演示：${s.canvasLayer}/3 层；节点可编辑，未连接真实 AI。`;
      if (s.page < 2) return `讲义 ${s.page + 1}/6；R=${s.angle}°；${s.operation === 'RF' ? '先旋转后反射' : '先反射后旋转'}。`;
      if (s.page === 2) return '阅读群的定义：结合律、单位元、逆元；交换律不是必要条件。阅读不计为核验通过。';
      if (s.page === 3) return `C₄ 运算表；本页 R 固定为 90°。${/^[0-3],[0-3]$/.test(s.answer) ? `选择指数 ${s.answer} 的乘积。` : '尚未选择表格项。'}`;
      if (s.page === 4) return `单位元唯一性：已展开 ${s.proof}/3 步示范，不计为独立完成。`;
      return s.answer === 'correct' ? '局部判断正确：不交换不足以否定一个群。只核验这一题，不代表完整课程掌握。' : s.answer === 'wrong' ? '局部判断需修正：误把交换律当作群的必要条件。' : '尚未提交本节局部核验。';
    }
    case 'physics': return `m=${s.mass} kg，k=${s.stiffness} N/m，T=${period(s.mass, s.stiffness).toFixed(2)} s；理想无阻尼模型，A=0.20 m。`;
    case 'systems': return `执行第 ${s.step}/10 步：${trace[s.step].note}。固定轨迹，不是在线编译。`;
    case 'history': return s.stage ? `虚构教学材料判断：${s.judgments.join(' / ')}；不是历史结论。` : `地球视角 ${s.lon.toFixed(1)}° 经度 / ${s.lat.toFixed(1)}° 纬度；${s.route ? '显示' : '隐藏'}假设路径，${s.strokes.length} 条批注。路径不是已证实的入侵路线。`;
    case 'guitar': return s.stage ? `听辨选择第 ${s.beat} 拍；此素材预设差异在第 4 拍。不是学生演奏评分。` : `视频位置 ${s.videoTime.toFixed(2)} s；谱面第 ${s.beat || 1} 拍。原创指板示意，非实拍。`;
    case 'photo': return s.stage ? `组照顺序：${s.picks.map(i => contactNames[i]).join(' → ') || '未选择'}。示意构图，非实拍。` : `批注 ${s.point}；亮度预览 ${s.exposure}%；${s.grid ? '显示' : '隐藏'}网格。预览不等于曝光计算。`;
  }
}
export function learningMarkdown(store: LearningStore, id: SubjectId) {
  const r = store.subjects[id];
  return [`# ${subjectInfo[id].name} · 学习手记`, '', '前端本地记录；未连接真实教授，不作为完整课程掌握证明。', '', '## 我的理解', r.note, '', '## 学习证据', ...r.evidence.map(e => `\n### ${e.kind === 'student' ? '学生原话 · 待核验' : e.kind === 'example' ? '示范' : '对象快照'}\n${e.text}`)].join('\n');
}
