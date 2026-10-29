-- Compatibility identity only; per-run authority remains the frozen Harness snapshot.
insert into role_def(id,bench,prompt_ref,model_tier,tool_grants,read_scope,write_targets,steps)
values('research-clarify','research','prompts/research/research-clarify.md','cheap','{"literature":{"risk":"read","permission":"allow"},"question":{"risk":"read","permission":"allow"},"task":{"risk":"danger","permission":"deny"}}','{"dossier":"current","metadata":"public"}','[]',6);
create function reinlab_clarify_revision() returns trigger language plpgsql as $$
begin
 if row(new.account_id,new.dossier_id) is distinct from row(old.account_id,old.dossier_id) or new.selection_revision<old.selection_revision then raise exception 'CLARIFY_REVISION' using errcode='23514';end if;
 if row(new.chosen_id,new.chosen_approval,new.closed) is distinct from row(old.chosen_id,old.chosen_approval,old.closed) and new.selection_revision<=old.selection_revision then raise exception 'CLARIFY_REVISION' using errcode='23514';end if;
 return new;
end $$;
revoke all on function reinlab_clarify_revision() from public;
create trigger clarify_revision before update on read_clarification for each row execute function reinlab_clarify_revision();
