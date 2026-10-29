# B-6：显式关闭 DeepSeek 思考

ToSpec：2026-10-22追加审查B-6；产品路由保持deepseek/deepseek-v4-flash，SDK模型options.thinking.type=disabled，不修改上游。提交前从受信raw config核对该值；原生出站请求必须带同值，不能仅看reasoning能力。

ToTDD：先补SDK配置与原生请求体断言，原实现11通过/2失败，失败分别为缺模型options与wire thinking为undefined，见red.json及native-red/native-catalog.json。实现后相关17/17、0失败，见green.json。native-green/native-catalog.json的outboundRequests为本机fixture截获的实际JSON请求体，thinking={type:disabled}，并非手造配置证明。

只使用npm OpenScience2.0.150、本机fixture和临时认证值，真实模型请求0、真实key读取0。测试中的本机fixture回复不能视为线上通过。B-7及B-8在后续步骤加强守卫与fixture协议；P1-10仍未关闭。
