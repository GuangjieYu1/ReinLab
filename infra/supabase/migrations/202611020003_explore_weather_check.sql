-- 探索台 EXPL 第 3 批：待执行计划的天气监测（06 §5.2、07 契约第 2、4、8 节）。
--
-- 控制面按账户时区每天 08/16/23 取一次真实预报：没有明显变化就安静记一笔，
-- 有影响就生成一条调整建议（复用 approval，进收件箱和对话）。
-- 每次模型判断的 token 计入这份计划；后台调用没有 run，所以 run_id 允许为空。

alter table explore_plan add column if not exists next_check_at timestamptz;
create index if not exists explore_plan_due_idx
  on explore_plan(next_check_at) where state = 'ready';

alter table usage_record alter column run_id drop not null;
alter table usage_record add column if not exists purpose text;
create index if not exists usage_record_dossier_idx
  on usage_record(account_id, dossier_id, purpose);

-- 一次检查的结果：给页面时间线、给下一次判断做基线、给用户事后查。
create table if not exists explore_weather_check (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  dossier_id uuid not null,
  checked_at timestamptz not null default now(),
  -- 哪一次: 08 / 16 / 23；manual 是手动触发
  slot text not null,
  -- schedule = 到点跑; catchup = 服务停了错过、重启补的那一次
  reason text not null check (reason in ('schedule','catchup','manual')),
  plan_revision integer not null,
  -- no_change = 预报没变，不用问模型; checked = 变了但判断没影响;
  -- suggested = 有建议进收件箱; failed / out_of_range = 如实记录，不当成没变化
  state text not null check (state in ('no_change','checked','suggested','failed','out_of_range','skipped')),
  summary text,
  detail jsonb not null default '{}'::jsonb,
  suggestion_id uuid,
  judge_model text,
  judge_known boolean,
  foreign key (account_id, dossier_id) references dossier(account_id, id)
);
alter table explore_weather_check enable row level security;
alter table explore_weather_check force row level security;
create policy tenant_scope on explore_weather_check to reinlab_app
  using (account_id = nullif(current_setting('app.account_id', true), '')::uuid)
  with check (account_id = nullif(current_setting('app.account_id', true), '')::uuid);
grant select, insert on explore_weather_check to reinlab_app;

-- 调度要跨账户找「到点的计划」：应用角色按 RLS 只能看自己账户，
-- 所以只给这一个最小查询的 definer 函数（只回 id 与时间，不含任何计划内容）。
create function public.reinlab_explore_due_plans(max_rows int default 5)
returns table(account_id uuid, dossier_id uuid, timezone text, next_check_at timestamptz, plan_revision integer)
language sql security definer set search_path = pg_catalog, public as $$
  select p.account_id, p.dossier_id, a.timezone, p.next_check_at, p.revision
    from public.explore_plan p
    join public.dossier d on d.account_id = p.account_id and d.id = p.dossier_id
    join public.account a on a.id = p.account_id
   where p.state = 'ready'
     and d.lifecycle = 'active'
     and d.deletion = 'none'
     and a.timezone is not null
     and (p.next_check_at is null or p.next_check_at <= now())
   order by p.next_check_at nulls first
   limit greatest(1, least(coalesce(max_rows, 5), 50));
$$;

revoke all on function public.reinlab_explore_due_plans(int) from public, reinlab_app;
grant execute on function public.reinlab_explore_due_plans(int) to reinlab_app;
