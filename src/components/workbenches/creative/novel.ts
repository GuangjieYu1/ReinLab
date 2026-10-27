// 《红皮书的最后一页》正文（原创同人文字，不引用原著原文；纯前端示例）。

export type Para = { id: string; text: string };
export type Scene = { id: string; title: string; cast: string[]; place: string; when: string; beat: string; paras: Para[] };
export type Chapter = { id: string; no: string; title: string; scenes: Scene[] };

export const CHAPTERS: Chapter[] = [
  { id: 'c1', no: '第 1 章', title: '仲夏之后', scenes: [
    { id: 'c1s1', title: '书房的灯', cast: ['sam', 'rose'], place: 'bagend', when: '1482 · 夏末', beat: '开场 · 失去', paras: [
      { id: 'p1', text: '罗丝走后的第七个星期，山姆第一次在白天点了书房的灯。袋底洞窗外还是夏末的光，可他觉得屋里比任何时候都暗。' },
      { id: 'p2', text: '西界红皮书摊在桌上，翻到他自己写的那一部分。字迹一年比一年歪，最后几行几乎是趴着写的。他把笔尖在袖口上擦了擦，又放下了。' },
    ] },
    { id: 'c1s2', title: '金色的叶子', cast: ['sam'], place: 'hobbiton', when: '1482 · 夏末', beat: '征兆', paras: [
      { id: 'p3', text: '傍晚他去宴会场看那棵瑁珑树。叶子刚开始泛金，比往年早了半个月。山姆想，树也许知道些什么，就像霍比特人在下雨之前总会膝盖发酸。' },
    ] },
  ] },
  { id: 'c2', no: '第 2 章', title: '信使与客人', scenes: [
    { id: 'c2s1', title: '国王的问候', cast: ['sam'], place: 'bagend', when: '1482 · 九月初', beat: '召唤', paras: [
      { id: 'p4', text: '刚铎的信使在九月的第一天到了，带来埃莱萨王的问候，还有一句只写给山姆的话：船已经在灰港等着。' },
      { id: 'p5', text: '「银风号，」信使说，「他们是这么叫它的。」山姆点点头，好像早就知道这个名字。' },
    ] },
    { id: 'c2s2', title: '补斗篷', cast: ['sam', 'elanor'], place: 'bagend', when: '1482 · 九月', beat: '告别', paras: [
      { id: 'p6', text: '那天晚上伊拉诺来了。她没有问父亲要去哪里，只是把壁炉里的灰扫干净，又把他的旧斗篷补了两针。' },
    ] },
  ] },
  { id: 'c3', no: '第 3 章', title: '最后一页', scenes: [
    { id: 'c3s1', title: '塔下', cast: ['elanor'], place: 'undertowers', when: '1482 · 秋', beat: '交接', paras: [
      { id: 'p7', text: '山姆走后的第三天，伊拉诺在塔下打开了红皮书。比尔博的字瘦而尖，弗罗多的字工整，父亲的字像田垄一样朴实。她一页一页地往后翻，像在走一条很长的路。' },
    ] },
    { id: 'c3s2', title: '陌生的字迹', cast: ['elanor', 'frodo'], place: 'undertowers', when: '1482 · 秋', beat: '谜面', paras: [
      { id: 'p8', text: '她想起父亲讲过的一个下午：弗罗多坐在袋底洞的窗边，他伸出十指，按住书页，说有些故事要等写的人离开之后才算写完。' },
      { id: 'p9', text: '最后一页本该是空白的——她记得很清楚，父亲交给她的时候，那一页什么都没有。可现在上面有一行字，墨迹还没完全干透。那不是比尔博的字，不是弗罗多的，也不是她父亲的。' },
      { id: 'p10', text: '落款的日期是' },
    ] },
  ] },
];

/** 补全（本地模拟）：句子开头 → 续写。 */
export const COMPLETIONS: [string, string][] = [
  ['落款的日期是', '夏尔历 1482 年 9 月 29 日。那一天，还没有到来。'],
  ['她合上书', '，听见窗外有人在唱一首她从没听过的歌，调子却像是父亲常哼的那一首。'],
  ['山姆', '把信折好，放进了斗篷内侧的口袋。'],
];
/** 「续写本场」生成的段落。 */
export const CONTINUE: Record<string, string> = {
  c3s2: '伊拉诺把书合上，又打开。那行字还在。她没有去叫丈夫，也没有点更多的灯，只是把椅子往窗边挪了挪——像很多年前，父亲在袋底洞做的那样。',
  c2s2: '临走前，伊拉诺把补好的斗篷搭在椅背上。山姆摸了摸新缝的线脚，说：「你母亲缝得比这还歪。」两个人都笑了，笑完谁也没再说话。',
  c1s1: '他终于还是蘸了墨，在最后一页上方写下日期，又划掉。有些事，他想，得留给后来的人去写。',
};
/** 改写语气的两种样例（对当前场景的第一段）。 */
export const TONES: { id: string; label: string; apply: (t: string) => string }[] = [
  { id: 'plain', label: '更克制', apply: t => t.replace(/，可他觉得屋里比任何时候都暗。/, '。屋里很暗。').replace(/像在走一条很长的路。/, '') },
  { id: 'warm', label: '更温暖', apply: t => t.replace(/。$/, '，就像有人在远处轻轻地喊她的名字。') },
];

/** 「转为分镜」：把一个场景拆成镜头草稿，带上出场人物与地点。 */
export type Shot = { no: string; size: string; move: string; desc: string; cast: string[]; secs: number };
export const SHOTS: Shot[] = [
  { no: '镜 01', size: '远景', move: '缓推', desc: '黄昏，袋底洞的圆门，花园里的花已经开败', cast: [], secs: 4 },
  { no: '镜 02', size: '中景', move: '固定', desc: '信使在门口递出一封盖着白树纹章的信', cast: ['sam'], secs: 3 },
  { no: '镜 03', size: '特写', move: '固定', desc: '山姆布满老茧的手展开信纸', cast: ['sam'], secs: 3 },
  { no: '镜 04', size: '中景', move: '横移', desc: '壁炉边，伊拉诺低头补斗篷', cast: ['elanor'], secs: 4 },
  { no: '镜 05', size: '远景', move: '升', desc: '宴会场上的瑁珑树，叶子开始泛金', cast: [], secs: 5 },
  { no: '镜 06', size: '特写', move: '缓推', desc: '红皮书的最后一页，一行陌生的字迹', cast: [], secs: 4 },
];
