-- Backfill rows created by the previous writer between adding columns and enforcing them.
UPDATE budget_allocation a SET quota_limit=coalesce(a.quota_limit,r.quota_limit),gpu_limit=coalesce(a.gpu_limit,r.gpu_limit) FROM run r WHERE a.run_id=r.id;
UPDATE budget_allocation SET quota_limit=coalesce(quota_limit,0),gpu_limit=coalesce(gpu_limit,0) WHERE delegation_id IS NOT NULL;
WITH RECURSIVE tree AS(SELECT id ancestor,id FROM budget_allocation UNION ALL SELECT t.ancestor,c.id FROM tree t JOIN budget_allocation c ON c.parent_id=t.id),
 totals AS(SELECT t.ancestor,coalesce(sum(h.actual_quota),0) quota,coalesce(sum(h.actual_gpu_seconds),0) gpu FROM tree t LEFT JOIN budget_hold h ON h.allocation_id=t.id GROUP BY t.ancestor)
UPDATE budget_allocation a SET quota_spent=t.quota,gpu_spent=t.gpu FROM totals t WHERE a.id=t.ancestor;
ALTER TABLE budget_allocation ADD CHECK(parent_id IS NULL OR(quota_limit IS NOT NULL AND gpu_limit IS NOT NULL));
WITH totals AS(SELECT run_id,sum(spent_cny) spent,sum(quota_spent) quota,sum(gpu_spent) gpu FROM budget_allocation WHERE run_id IS NOT NULL GROUP BY run_id)
UPDATE run r SET spent_cny=t.spent,quota_runs=t.quota,gpu_seconds=t.gpu FROM totals t WHERE r.id=t.run_id;
