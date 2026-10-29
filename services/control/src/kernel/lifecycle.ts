import type { Database } from "../db/database";

/** 等待人回答默认多久算超时（用户定：24 小时）。 */
export const DEFAULT_ANSWER_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 运行生命周期的收尾。
 *
 * 两件事，都只作用当前账户：
 * 1. 超过业务时限还没人处理的请求，关掉并说明原因；它的任务如果没别的待办，按中断收尾。
 * 2. 进程已经不在、但状态还停在执行中的任务，补成真实终态并释放占用，不留人工 SQL。
 *
 * 等待本身不是残留：`waiting` 的任务原样保留，请求仍可回答。
 */
export async function reconcileAccount(
  db: Database,
  account: string,
  options: {
    ttlMs?: number;
    now?: () => Date;
    /**
     * 这一段执行是否还活着。没有这个判据时只处理超时请求，不猜执行是否残留，
     * 免得把正在跑的任务判成孤儿。
     */
    isLive?: (runId: string) => boolean;
  } = {},
): Promise<{ expiredRequests: number; interruptedRuns: number }> {
  const ttlMs = options.ttlMs ?? DEFAULT_ANSWER_TTL_MS;
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - ttlMs);
  return db.withAccount(account, async (client) => {
    // 1) 超时未处理的请求
    const stale = (
      await client.query(
        `update approval set state='expired'
          where account_id=$1 and state='pending' and created_at < $2
          returning id, run_id`,
        [account, cutoff.toISOString()],
      )
    ).rows;
    for (const row of stale)
      await client.query(
        `insert into event(account_id,dossier_id,run_id,role_id,kind,action,risk,payload,dedupe_key)
         select $1::uuid,r.dossier_id,r.id,r.role_id,'approval','approval.expired','write',
                jsonb_build_object('approvalId',$2::text,'reason','timeout'),
                'lifecycle-expired:'||$2::text
           from run r where r.id=$3::uuid`,
        [account, row.id, row.run_id],
      );

    // 1b) 请求关了以后没有别的待办、也不在执行中的任务，按中断收尾
    const stranded = (
      await client.query(
        `update run set state='interrupted', ended_at=now()
          where account_id=$1 and state='waiting' and ended_at is null
            and not exists (select 1 from approval a where a.run_id=run.id and a.state='pending')
          returning id, dossier_id`,
        [account],
      )
    ).rows;
    for (const row of stranded) {
      await client.query(
        `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
         values($1::uuid,$2::uuid,$3::uuid,'run','run.interrupted',
                jsonb_build_object('reason','answer_timeout','message','等待超过 24 小时没有处理，已结束这一轮；已有的成果保留。'),
                'lifecycle-interrupted:'||$3::text)`,
        [account, row.dossier_id, row.id],
      );
      await client.query(
        "update dsh_session set lease_run_id=null, lease_state='active', leased_until=null where account_id=$1 and lease_run_id=$2",
        [account, row.id],
      );
    }

    // 2) 进程已经不在、状态还停在执行中的任务
    const candidates = options.isLive
      ? (
          await client.query(
            `select id, dossier_id from run
              where account_id=$1 and state in ('queued','running') and ended_at is null`,
            [account],
          )
        ).rows.filter((row) => !options.isLive!(row.id))
      : [];
    const orphaned: Array<{ id: string; dossier_id: string }> = [];
    for (const candidate of candidates) {
      const updated = await client.query(
        "update run set state='interrupted', ended_at=now() where id=$1 and state in ('queued','running') and ended_at is null returning id, dossier_id",
        [candidate.id],
      );
      if (updated.rows[0]) orphaned.push(updated.rows[0]);
    }
    for (const row of orphaned) {
      await client.query(
        `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
         values($1::uuid,$2::uuid,$3::uuid,'run','run.interrupted',
                jsonb_build_object('reason','execution_lost','message','这一段执行已经结束但没留下终态，已按中断收尾；可以重试。'),
                'lifecycle-orphan:'||$3::text)`,
        [account, row.dossier_id, row.id],
      );
      await client.query(
        "update dsh_session set lease_run_id=null, lease_state='active', leased_until=null where account_id=$1 and lease_run_id=$2",
        [account, row.id],
      );
      // 这一段的待办已经没有执行者，关掉并说明原因。
      await client.query(
        "update approval set state='expired' where account_id=$1 and run_id=$2 and state='pending'",
        [account, row.id],
      );
    }

    return { expiredRequests: stale.length, interruptedRuns: stranded.length + orphaned.length };
  });
}
