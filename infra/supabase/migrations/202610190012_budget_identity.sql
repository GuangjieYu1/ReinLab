-- Accounting may change counters and decisions, never the identity/source of an existing receipt.
REVOKE UPDATE ON budget_allocation,budget_hold FROM reinlab_app;
GRANT UPDATE(amount_cny,spent_cny,quota_limit,gpu_limit,quota_spent,gpu_spent) ON budget_allocation TO reinlab_app;
GRANT UPDATE(state,actual_cny,actual_quota,actual_gpu_seconds,settlement_hash,receipt,event_seq) ON budget_hold TO reinlab_app;
CREATE FUNCTION reinlab_budget_tree_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.parent_id IS NOT NULL AND EXISTS(
  WITH RECURSIVE path AS (
   SELECT id,parent_id,ARRAY[id] visited,1 depth,false cycle FROM public.budget_allocation WHERE id=NEW.parent_id
   UNION ALL
   SELECT p.id,p.parent_id,c.visited||p.id,c.depth+1,p.id=ANY(c.visited)
   FROM public.budget_allocation p JOIN path c ON p.id=c.parent_id WHERE NOT c.cycle AND c.depth<32
  ) SELECT 1 FROM path WHERE id=NEW.id OR parent_id=NEW.id OR cycle OR depth>=32
 ) THEN RAISE EXCEPTION 'budget source cycle or depth limit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER budget_tree_guard BEFORE INSERT OR UPDATE OF parent_id ON budget_allocation FOR EACH ROW EXECUTE FUNCTION reinlab_budget_tree_guard();
