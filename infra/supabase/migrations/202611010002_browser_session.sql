-- 地基第 5 项登录会话（design/prd/04-session-contract.md）。
--
-- 浏览器只拿一个 HttpOnly Cookie，里面是不透明的会话标识；库里存它的 SHA-256。
-- created_at 是绝对期限（90 天）的起点，last_used_at 是空闲期限（30 天）的起点：
-- 只有登录、恢复会话、touch 会顺延 last_used_at，轮询和 SSE 不写这两个时间。
create table browser_session (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references account(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index browser_session_account_idx on browser_session(account_id);
alter table browser_session enable row level security;
alter table browser_session force row level security;

-- 认 Cookie 的时候还不知道是哪个账户，拿不到 app.account_id：
-- 表本身不对应用角色开放，只走下面这四个 definer 函数。
revoke all on browser_session from public, reinlab_app;

create function public.reinlab_session_open(aid uuid, th text)
returns table(account_id uuid, display_name text, created_at timestamptz, last_used_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if not exists(select 1 from public.account a where a.id=aid) then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode='23503';
  end if;
  return query
    with opened as (
      insert into public.browser_session(account_id, token_hash) values(aid, th)
      returning browser_session.account_id, browser_session.created_at, browser_session.last_used_at
    )
    select o.account_id, a.display_name, o.created_at, o.last_used_at
      from opened o join public.account a on a.id=o.account_id;
end $$;

create function public.reinlab_session_read(th text)
returns table(account_id uuid, display_name text, created_at timestamptz, last_used_at timestamptz, revoked_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  return query
    select s.account_id, a.display_name, s.created_at, s.last_used_at, s.revoked_at
      from public.browser_session s join public.account a on a.id=s.account_id
     where s.token_hash=th;
end $$;

-- 顺延空闲起点；已撤销的会话不再续期。
create function public.reinlab_session_touch(th text)
returns boolean
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.browser_session set last_used_at=now()
   where token_hash=th and revoked_at is null;
  return found;
end $$;

create function public.reinlab_session_revoke(th text)
returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  update public.browser_session set revoked_at=now()
   where token_hash=th and revoked_at is null;
end $$;

revoke all on function public.reinlab_session_open(uuid,text) from public, reinlab_app;
revoke all on function public.reinlab_session_read(text) from public, reinlab_app;
revoke all on function public.reinlab_session_touch(text) from public, reinlab_app;
revoke all on function public.reinlab_session_revoke(text) from public, reinlab_app;
grant execute on function public.reinlab_session_open(uuid,text) to reinlab_app;
grant execute on function public.reinlab_session_read(text) to reinlab_app;
grant execute on function public.reinlab_session_touch(text) to reinlab_app;
grant execute on function public.reinlab_session_revoke(text) to reinlab_app;
