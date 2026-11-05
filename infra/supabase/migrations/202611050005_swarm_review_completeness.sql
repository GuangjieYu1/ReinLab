-- 17 返工：核实门禁补一条——否定式结论要「读全了原文」才能判已核实。
-- 审查记录里带上核实者的读法完整性，页面上能直接看到。
alter table swarm_review add column if not exists read_completeness text
  check (read_completeness in ('full','partial'));
comment on column swarm_review.read_completeness is
  '核实者是否读全了原文：full 读全 / partial 有截断或只读了部分；否定式结论只有 full 才能判已核实';
