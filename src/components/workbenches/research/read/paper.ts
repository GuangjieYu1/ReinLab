// 精读模式的示例论文（纯前端示例数据）。原文内容均为转述，不照搬论文文字。

export type Section = { id: string; no: string; title: string; gist: string[] };
export const PAPER = {
  title: 'Attention Is All You Need',
  authors: 'Vaswani 等 · Google Brain / Google Research',
  venue: 'NeurIPS 2017',
  code: 'tensor2tensor（官方实现）',
  sections: [
    { id: 's1', no: '§1', title: '引言', gist: ['当时的序列模型主要靠循环网络，必须一个位置接一个位置地算，难以并行。', '注意力机制已经常被拿来辅助循环网络。作者提出：完全去掉循环，只用注意力。'] },
    { id: 's3', no: '§3', title: '模型结构', gist: ['仍是编码器—解码器结构，各由 6 层堆叠而成。', '每层有两个子层：多头自注意力、逐位置的前馈网络；每个子层外面套残差连接与层归一化。'] },
    { id: 's321', no: '§3.2.1', title: '缩放点积注意力', gist: ['用查询与每个键做点积，得到相关程度；经 softmax 变成权重，再对值加权求和。', '点积要除以 √dₖ。作者的解释：维度大时点积的数值会变得很大，把 softmax 推进梯度极小的区域。'] },
    { id: 's322', no: '§3.2.2', title: '多头注意力', gist: ['把查询、键、值分别投影到多组低维空间，并行做多次注意力，再拼接起来。', '好处是不同的头可以同时关注不同位置、不同类型的关系；论文用了 8 个头。'] },
    { id: 's35', no: '§3.5', title: '位置编码', gist: ['注意力本身不关心顺序，所以要把位置信息加进输入。', '用不同频率的正弦和余弦作为位置编码；作者推测，这样模型容易学会按相对位置去关注，因为位置偏移一个固定量，编码就是一个线性变换。'] },
    { id: 's4', no: '§4', title: '为什么用自注意力', gist: ['从三个角度比较：每层计算量、能否并行、任意两个位置之间信号要走多远。', '自注意力让任意两个位置一步就连上；循环网络要走 n 步。'] },
    { id: 's6', no: '§6', title: '实验结果', gist: ['英德翻译 WMT 2014 上，大模型 BLEU 28.4，超过当时包括集成模型在内的最好结果；基础模型 27.3。', '基础模型在 8 块 P100 上训练约 12 小时，训练成本远低于此前的模型。'] },
  ] as Section[],
};

/** 五层解析：每一层都链接回原文段落。 */
export type Layer = { id: string; no: string; title: string; en: string; body: { text: string; refs: string[] }[]; anim?: string };
export const LAYERS: Layer[] = [
  { id: 'l1', no: '01', title: '一句话', en: 'ONE LINE', body: [{ text: '别再让模型一个字一个字地按顺序读了——让每个字直接去「看」句子里所有其他字，自己决定该关注谁。', refs: ['s1'] }] },
  { id: 'l2', no: '02', title: '直觉', en: 'INTUITION', body: [
    { text: '循环网络像传话游戏：第一个人的话要经过一长串人才能传到最后，越传越走样，而且必须一个接一个，没法同时进行。', refs: ['s1', 's4'] },
    { text: '注意力像开圆桌会议：每个人都能直接听到所有人说话，再按「和我有多相关」分配注意力。所有人可以同时听，所以能并行。', refs: ['s4'] },
  ] },
  { id: 'l3', no: '03', title: '机理', en: 'MECHANISM', anim: 'scaled', body: [
    { text: '每个字生成三样东西：查询 Q（我想找什么）、键 K（我有什么）、值 V（我能提供什么）。', refs: ['s321'] },
    { text: '拿我的 Q 和所有人的 K 做点积，得到「相关度」；除以 √d 防止数值过大；softmax 变成加起来为 1 的权重；按权重把大家的 V 混合起来，就是我的新表示。', refs: ['s321'] },
    { text: '同时开 8 组这样的「会议」（多头），每组关注不同的关系，最后拼起来。', refs: ['s322'] },
    { text: '会议本身不知道谁先谁后，所以给每个位置加一段不同频率的正弦波，当作「座位号」。', refs: ['s35'] },
  ] },
  { id: 'l4', no: '04', title: '证据', en: 'EVIDENCE', body: [
    { text: '证明了：在英德、英法翻译上效果超过当时最好的模型，而且训练快得多。', refs: ['s6'] },
    { text: '没证明：自注意力在所有任务上都更好；也没有解释清楚多头里每个头到底学到了什么——这些是后来的工作在回答。', refs: ['s6', 's322'] },
  ] },
  { id: 'l5', no: '05', title: '洞见与局限', en: 'INSIGHT', body: [
    { text: '洞见：真正的突破不只是「注意力」，而是「去掉顺序依赖 → 能并行 → 能用更多数据和算力训练更大的模型」。这条链条为后来的大模型铺了路。', refs: ['s1', 's4'] },
    { text: '√d 这个看似不起眼的缩放，决定了训练能不能稳定进行——去「动画」里拖一下维度就能看到。', refs: ['s321'] },
    { text: '局限：注意力的计算量随长度平方增长，长文本很贵；这成了此后大量研究（稀疏注意力、线性注意力等）的出发点。', refs: ['s4'] },
  ] },
];

/** 理解检验题。keys：答到这些要点之一就算命中。 */
export type Quiz = { id: string; q: string; keys: string[][]; hint: string; layer: string };
export const QUIZ: Quiz[] = [
  { id: 'q1', q: '为什么点积要除以 √d？不除会怎样？', keys: [['大', '变大', '数值'], ['softmax', '饱和', '梯度', '尖']], hint: '维度越大，点积数值越大，softmax 会变得极端（几乎只剩一个 1），梯度接近 0，训练学不动。', layer: 'l3' },
  { id: 'q2', q: '为什么 Transformer 能比循环网络训练得快？', keys: [['并行', '同时'], ['顺序', '依赖', '一个接一个', '循环']], hint: '它去掉了按顺序计算的依赖，所有位置可以同时计算，能充分利用 GPU 并行。', layer: 'l2' },
  { id: 'q3', q: '既然注意力不关心顺序，模型是怎么知道词序的？', keys: [['位置'], ['正弦', '余弦', '编码', '频率']], hint: '把不同频率的正弦 / 余弦位置编码加到输入上，相当于给每个位置一个「座位号」。', layer: 'l3' },
];

/** 读者可以问的问题（本地示例回答）。 */
export const QA: { keys: RegExp; answer: string; layer?: string; anim?: string; refs?: string[] }[] = [
  { keys: /根号|√|除以|缩放|scale/i, answer: '维度 d 越大，两个随机向量点积的方差大约随 d 增长，数值会很大；softmax 遇到大数值会变得几乎是 one-hot，梯度接近 0。除以 √d 把方差拉回到 1 左右。我把动画打开了，拖一下维度看看。', anim: 'scaled', refs: ['s321'] },
  { keys: /位置|顺序|正弦|sin/i, answer: '注意力对输入顺序是无感的。位置编码用一组不同频率的正弦 / 余弦，给每个位置一个独一无二又平滑变化的「指纹」，相近的位置指纹也相近。动画里点任意一行看相似度。', anim: 'pe', refs: ['s35'] },
  { keys: /多头|head/i, answer: '多头就是并行开几场「会议」，每场用不同的投影，于是各自擅长不同关系：有的看前一个词，有的看句首，有的看自己。动画里可以逐个打开头看。', anim: 'heads', refs: ['s322'] },
  { keys: /qkv|查询|键|值|query|key|value/i, answer: 'Q 是「我在找什么」，K 是「我能被怎样找到」，V 是「被找到后我交出什么」。用 Q 去和所有 K 比相关度，再按相关度混合 V。', layer: 'l3', refs: ['s321'] },
  { keys: /为什么.*快|并行|循环/i, answer: '循环网络第 t 步要等第 t-1 步算完；注意力里所有位置互不等待，一层里能同时算完，GPU 吃得满。', layer: 'l2', refs: ['s4'] },
];

/** 复现：论文结论 vs 本地最小复现。 */
export const CLAIMS = [
  { claim: '缩放点积注意力：除以 √dₖ 可避免 softmax 饱和', ours: '已复现：d = 512 时不缩放，最大注意力权重 0.99+，梯度范数下降两个数量级', status: 'done' as const },
  { claim: '位置编码：相对位置偏移是线性变换', ours: '已复现：PE(pos+k) 可由 PE(pos) 线性表示，拟合误差 < 1e-6', status: 'done' as const },
  { claim: '小规模模型能学会序列任务（拷贝 / 反转）', ours: '已复现：2 层、4 头、d=64，反转任务 2000 步达到 99% 准确率', status: 'done' as const },
  { claim: 'WMT14 英德 BLEU 27.3（base）/ 28.4（big）', ours: '未复现：需要完整数据集与约 8×P100 × 12 小时；可「交给自研」排期', status: 'todo' as const },
];
export const REPRO_CODE = `import torch, torch.nn.functional as F

def attention(q, k, v, scale=True):
    # q, k, v: (batch, heads, length, d)
    d = q.size(-1)
    scores = q @ k.transpose(-2, -1)
    if scale:
        scores = scores / d ** 0.5        # §3.2.1 的关键一行
    weights = F.softmax(scores, dim=-1)
    return weights @ v, weights

def positional_encoding(n, d):
    pos = torch.arange(n)[:, None]
    i = torch.arange(0, d, 2)
    freq = 1.0 / (10000 ** (i / d))
    pe = torch.zeros(n, d)
    pe[:, 0::2] = torch.sin(pos * freq)
    pe[:, 1::2] = torch.cos(pos * freq)
    return pe

# 最小复现：2 层 · 4 头 · d=64，在「序列反转」任务上训练
model = TinyTransformer(layers=2, heads=4, d=64)
train(model, task="reverse", steps=2000)`;
