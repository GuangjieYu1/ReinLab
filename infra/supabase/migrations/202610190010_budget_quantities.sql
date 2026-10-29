ALTER TABLE budget_allocation
 ADD COLUMN quota_limit bigint CHECK(quota_limit IS NULL OR quota_limit>=0),
 ADD COLUMN gpu_limit bigint CHECK(gpu_limit IS NULL OR gpu_limit>=0),
 ADD COLUMN quota_spent bigint NOT NULL DEFAULT 0 CHECK(quota_spent>=0),
 ADD COLUMN gpu_spent bigint NOT NULL DEFAULT 0 CHECK(gpu_spent>=0);
UPDATE budget_allocation a SET quota_limit=r.quota_limit,gpu_limit=r.gpu_limit FROM run r WHERE a.run_id=r.id;
UPDATE budget_allocation SET quota_limit=0,gpu_limit=0 WHERE delegation_id IS NOT NULL;
WITH RECURSIVE tree AS (
 SELECT id ancestor,id FROM budget_allocation
 UNION ALL SELECT t.ancestor,c.id FROM tree t JOIN budget_allocation c ON c.parent_id=t.id
), totals AS (
 SELECT t.ancestor,coalesce(sum(h.actual_quota),0) quota,coalesce(sum(h.actual_gpu_seconds),0) gpu
 FROM tree t LEFT JOIN budget_hold h ON h.allocation_id=t.id GROUP BY t.ancestor
) UPDATE budget_allocation a SET quota_spent=t.quota,gpu_spent=t.gpu FROM totals t WHERE a.id=t.ancestor;
