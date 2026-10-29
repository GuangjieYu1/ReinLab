// 创作台 · 示例作品：《魔戒》同人中篇《红皮书的最后一页》（纯前端示例数据）。
// 人物、地名与原著事实来自托尔金的设定；正文与设定描述均为原创同人文字，不引用原著原文。
// 世界观是创作台的「本体」：小说与视频都引用这里的实体；设定顾问持续检查正文与镜头是否与它矛盾。

export type Kind = 'person' | 'place' | 'faction' | 'object' | 'rule';
export const KIND: Record<Kind, { zh: string; en: string }> = {
  person: { zh: '人物', en: 'CHARACTERS' }, place: { zh: '地点', en: 'PLACES' }, faction: { zh: '势力', en: 'FACTIONS' },
  object: { zh: '物件', en: 'OBJECTS' }, rule: { zh: '规则', en: 'RULES' },
};
export type Entity = {
  id: string; kind: Kind; name: string; tagline: string;
  facts: [string, string][];
  voice?: string;
  appears: string[];
  x?: number; y?: number;
  map?: [number, number];
};
export const WORK = { title: '红皮书的最后一页', genre: '《魔戒》同人 · 中篇', logline: '山姆西去之前，把红皮书交给了伊拉诺。最后一页的字迹，不属于任何人。' };
export const ENTITIES: Entity[] = [
  { id: 'sam', kind: 'person', name: '山姆', tagline: '红皮书的第二位执笔人', x: 50, y: 46,
    facts: [['全名', '山姆卫斯·詹吉'], ['生年', '夏尔历 1380'], ['1482 年', '102 岁，刚失去罗丝'], ['外貌', '背已经驼了，手上全是园丁的老茧'], ['习惯', '写字前总要先把笔尖在袖口上擦一下']],
    voice: '慢，带一点霍比屯的乡音，说到弗罗多时会停住', appears: ['第 1 章', '第 2 章', '镜 01–06'] },
  { id: 'elanor', kind: 'person', name: '伊拉诺', tagline: '山姆的长女，红皮书的下一位保管人', x: 80, y: 20,
    facts: [['生年', '夏尔历 1421'], ['名字', '由弗罗多提议，取自罗瑞恩的一种金色小花'], ['外貌', '金发，在夏尔很少见'], ['性格', '安静、认真，会把父亲的每一句话记下来']],
    voice: '清亮、克制', appears: ['第 2 章', '第 3 章', '镜 07–12'] },
  { id: 'frodo', kind: 'person', name: '弗罗多', tagline: '只在回忆与书页里出现', x: 18, y: 20,
    facts: [['生年', '夏尔历 1368'], ['离开', '1421 年秋，从灰港西去'], ['身体', '在末日山失去了一根手指'], ['在本作中', '只以回忆和红皮书里的字迹出现']],
    voice: '（回忆）轻而温和', appears: ['第 1 章', '第 3 章', '镜 03'] },
  { id: 'rose', kind: 'person', name: '罗丝', tagline: '山姆的妻子，1482 年仲夏去世', x: 22, y: 78,
    facts: [['全名', '罗丝·科顿'], ['成婚', '1420 年，与山姆'], ['在本作中', '故事开始时已经去世，只在山姆的回忆里出现']],
    voice: '（回忆）爽朗', appears: ['第 1 章'] },
  { id: 'merry', kind: 'person', name: '梅里', tagline: '每年夏天都会来一趟', x: 82, y: 72,
    facts: [['全名', '梅里阿道克·烈酒鹿'], ['在本作中', '自称每年夏天来袋底洞看山姆']],
    voice: '爽快，爱开玩笑', appears: ['第 2 章'] },
  { id: 'shire', kind: 'place', name: '夏尔', tagline: '霍比特人的家园', map: [62, 40], facts: [['时节', '本作发生在 1482 年夏末秋初']], appears: ['全书'] },
  { id: 'bagend', kind: 'place', name: '袋底洞', tagline: '山姆一家的家', map: [70, 30], facts: [['特征', '圆门、门前的花园，书房里收着红皮书']], appears: ['第 1 章', '第 2 章', '镜 01–06'] },
  { id: 'hobbiton', kind: 'place', name: '霍比屯', tagline: '袋底洞所在的村子', map: [76, 50], facts: [['特征', '宴会场上那棵瑁珑树']], appears: ['第 2 章', '镜 05'] },
  { id: 'undertowers', kind: 'place', name: '塔下', tagline: '伊拉诺婚后的住处', map: [36, 46], facts: [['位置', '西界，靠近塔丘']], appears: ['第 3 章', '镜 10'] },
  { id: 'havens', kind: 'place', name: '灰港', tagline: '精灵西去的港口', map: [14, 68], facts: [['氛围', '灰色的石阶、白色的船、海风很冷']], appears: ['第 3 章', '镜 11', '镜 12'] },
  { id: 'hobbits', kind: 'faction', name: '霍比特人', tagline: '夏尔的居民', facts: [['在本作中', '大多数人只把红皮书当成老山姆的故事']], appears: ['全书'] },
  { id: 'gondor', kind: 'faction', name: '刚铎', tagline: '埃莱萨王的王国', facts: [['在本作中', '每年都有信使带来国王的问候']], appears: ['第 2 章'] },
  { id: 'redbook', kind: 'object', name: '西界红皮书', tagline: '比尔博、弗罗多、山姆接力写成', facts: [['执笔', '比尔博 → 弗罗多 → 山姆'], ['异常', '最后一页的字迹不属于他们中的任何一个人']], appears: ['第 1 章', '第 3 章', '镜 04', '镜 08'] },
  { id: 'mallorn', kind: 'object', name: '瑁珑树', tagline: '用加拉德瑞尔的礼物种下', facts: [['特征', '整个夏尔唯一的一棵，秋天叶子变成金色']], appears: ['第 2 章', '镜 05'] },
  { id: 'west', kind: 'rule', name: '西去', tagline: '持戒者可以乘船西去', facts: [['规则', '曾经持有魔戒的人，可以从灰港乘船西去'], ['在本作中', '山姆是最后一位']], appears: ['第 3 章', '镜 11'] },
];
export const RELATIONS: { a: string; b: string; label: string; oneWay?: boolean }[] = [
  { a: 'sam', b: 'frodo', label: '一路走到末日山' },
  { a: 'sam', b: 'rose', label: '夫妻 · 1420 年成婚' },
  { a: 'elanor', b: 'sam', label: '长女' },
  { a: 'frodo', b: 'elanor', label: '为她取名' },
  { a: 'merry', b: 'sam', label: '自称每年夏天来访', oneWay: true },
  { a: 'elanor', b: 'rose', label: '母女' },
];
export const TIMELINE: { year: number; text: string; who: string[]; flag?: string }[] = [
  { year: 1368, text: '弗罗多出生', who: ['frodo'] },
  { year: 1380, text: '山姆出生', who: ['sam'] },
  { year: 1418, text: '魔戒圣战，山姆随弗罗多走到末日山', who: ['sam', 'frodo'] },
  { year: 1420, text: '山姆与罗丝成婚，搬进袋底洞', who: ['sam', 'rose'] },
  { year: 1421, text: '伊拉诺出生；那一年三十出头的山姆当了父亲', who: ['elanor', 'sam'], flag: 'age' },
  { year: 1421.7, text: '弗罗多从灰港西去，把红皮书留给山姆', who: ['frodo', 'sam'] },
  { year: 1482, text: '仲夏，罗丝去世', who: ['rose'] },
  { year: 1482.7, text: '山姆把红皮书交给伊拉诺，启程去灰港；最后一页出现了陌生的字迹', who: ['sam', 'elanor'] },
];

/** 设定顾问的检查结果（参照 CanonKit 的问题类型，按人物 / 世界 / 情节 / 时间线分类）。 */
export type Issue = { id: string; cat: '人物' | '世界' | '情节' | '时间线'; title: string; detail: string; ents: string[]; where: string; options: string[] };
export const AUDIT: Issue[] = [
  { id: 'A1', cat: '时间线', title: '山姆的年龄前后不一致', detail: '山姆生于 1380 年，1421 年应是 41 岁；年表却写「三十出头的山姆当了父亲」。', ents: ['sam'], where: '年表 · 1421', options: ['年表改为「四十一岁的山姆」', '删掉年龄描述'] },
  { id: 'A2', cat: '人物', title: '单向关系：梅里 → 山姆', detail: '梅里的设定写「每年夏天来访」，山姆这边和第 1、2 章都没有任何关于梅里来访的记录。', ents: ['merry', 'sam'], where: '关系图', options: ['在第 2 章补一段梅里来访', '保留单向（梅里其实没来，这是伏笔）'] },
  { id: 'A3', cat: '人物', title: '弗罗多的手指与第 3 章冲突', detail: '弗罗多在末日山失去了一根手指；第 3 章回忆里写「他伸出十指，按住书页」。', ents: ['frodo'], where: '小说 · 第 3 章 · 场景 2', options: ['正文改为「九根手指」', '改成「他用掌心按住书页」'] },
  { id: 'A4', cat: '世界', title: '未登记的实体「银风号」', detail: '第 2 章提到山姆要搭的精灵船叫「银风号」，世界观里没有这个物件。', ents: ['havens'], where: '小说 · 第 2 章', options: ['加入世界观（物件）', '改成「一艘白色的船」，不起名字'] },
  { id: 'A5', cat: '情节', title: '最后一页是谁写的', detail: '红皮书的执笔人只有比尔博、弗罗多、山姆三位，最后一页的字迹却不属于任何一人。这是全书的谜面，需要至少一条线索。', ents: ['redbook', 'west'], where: '物件 · 西界红皮书', options: ['标记为「主线谜题」，不算冲突', '在第 3 章结尾安排线索'] },
];
