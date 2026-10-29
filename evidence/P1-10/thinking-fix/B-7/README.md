# B-7：守卫必须收到显式 disabled

ToSpec：追加审查B-7。thinking字段及type=disabled必须存在，畸形/额外键拒绝；验证在创建单次marker之前，拒绝不能消费资格，合法请求原样转发至固定DeepSeek地址且仅一次。

ToTDD：8种新增形态中，原代码对missing放行，得到32通过/1失败（red.json）；修复后作者33/33、0失败（green.json）。原先有效请求fixture显式加入disabled；未移除其他预算/认证/大小/并发/重启断言。

按用户限定只为安全边界派出GPT6.1 Sol中等推理独立子agent；独立35/35、0失败，P1/P2发现0。包括双模型别名14种畸形、拒绝后合法、body保真、并发唯一、失败重启，以及B-6被移除/改enabled后的拒绝清理。见independent/REVIEW.md及tests.json。真实模型请求0、真实key读取0。
