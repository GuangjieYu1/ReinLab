-- Explicit user decisions are delivered once; ambiguous delivery is reconciled by reads.
alter table approval add column decision_sent boolean not null default false;
alter table approval add check(not decision_sent or (decision_hash is not null and decision_input is not null));
alter table os_binding add column cancel_sent boolean not null default false;
alter table os_binding add column cancel_receipt jsonb;
create function reinlab_decision_delivery_guard() returns trigger language plpgsql as $$begin
 if old.decision_hash is not null and row(new.decision_hash,new.decision_input) is distinct from row(old.decision_hash,old.decision_input) then raise exception 'DECISION_INTENT_IMMUTABLE' using errcode='23514';end if;
 if old.decision_sent and not new.decision_sent then raise exception 'DECISION_SENT_IMMUTABLE' using errcode='23514';end if;
 if old.decision_receipt->>'status'='resolved' and new.decision_receipt is distinct from old.decision_receipt then raise exception 'DECISION_RECEIPT_IMMUTABLE' using errcode='23514';end if;
 return new;end $$;
revoke all on function reinlab_decision_delivery_guard() from public;
create trigger approval_decision_delivery_guard before update on approval for each row execute function reinlab_decision_delivery_guard();
create function reinlab_cancel_delivery_guard() returns trigger language plpgsql as $$begin
 if old.cancel_sent and not new.cancel_sent then raise exception 'CANCEL_SENT_IMMUTABLE' using errcode='23514';end if;
 if old.cancel_receipt->>'status'='resolved' and new.cancel_receipt is distinct from old.cancel_receipt then raise exception 'CANCEL_RECEIPT_IMMUTABLE' using errcode='23514';end if;
 return new;end $$;
revoke all on function reinlab_cancel_delivery_guard() from public;
create trigger os_binding_cancel_delivery_guard before update on os_binding for each row execute function reinlab_cancel_delivery_guard();
