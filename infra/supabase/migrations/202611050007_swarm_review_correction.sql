-- 18 广度返工：事后修正审查记录时，原值与修正理由都要留痕（af7b43dc 那种情况）。
alter table swarm_review add column if not exists corrected_from text;
alter table swarm_review add column if not exists correction_reason text;
comment on column swarm_review.corrected_from is '原判定（事后修正前的 verdict）；没修正过就是 null';
comment on column swarm_review.correction_reason is '为什么改，以及依据哪条门禁';
