-- 18 广度返工 D2：覆盖提醒去重用的水位（上次提醒时的「提到但没查」数量）。
alter table swarm_run add column if not exists coverage_mentioned integer not null default 0;
