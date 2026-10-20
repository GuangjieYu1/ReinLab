-- An eighth attempt may crash before finish(). A later worker must terminate
-- the expired lease, without replaying a possibly applied resource mutation.
create or replace function public.reinlab_provision_next(worker uuid)
returns table(job_account_id uuid,attempt int)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare chosen uuid;
begin
 if worker is null then raise exception 'WORKER_REQUIRED' using errcode='22023'; end if;
 update reinlab_meta.provision_job j set state='failed',worker_id=null,lease_until=null,
   last_error_code='PROVISION_ATTEMPTS_EXHAUSTED',updated_at=now()
 where j.attempts>=8 and (j.state='pending' or (j.state='leased' and j.lease_until<now()));
 select j.account_id into chosen from reinlab_meta.provision_job j
 where (j.state='pending' or (j.state='leased' and j.lease_until<now()))
 and j.next_attempt_at<=now() and j.attempts<8
 order by j.created_at,j.account_id for update skip locked limit 1;
 if chosen is null then return; end if;
 return query update reinlab_meta.provision_job j set state='leased',worker_id=worker,
   lease_until=now()+interval '5 minutes',attempts=j.attempts+1,updated_at=now()
   where j.account_id=chosen returning j.account_id,j.attempts;
end $$;
revoke all on function public.reinlab_provision_next(uuid) from public;
grant execute on function public.reinlab_provision_next(uuid) to reinlab_provisioner;
