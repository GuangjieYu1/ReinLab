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

    // 1a) 任务已经结束、卡还挂着的：一并关掉（历史遗留与漏网都在这收）。
    const orphanCards = (
      await client.query(
        `update approval set state='expired'
          where account_id=$1 and state='pending'
            and run_id in (select id from run
                            where account_id=$1
                              and state in ('completed','failed','cancelled','interrupted'))
          returning id, run_id`,
        [account],
      )
    ).rows;
    for (const row of orphanCards)
      await client.query(
        `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
         select $1::uuid,r.dossier_id,r.id,'approval','approval.expired',
                jsonb_build_object('approvalId',$2::text,'reason','run_ended'),
                'run-ended:'||$2::text
           from run r where r.id=$3::uuid
         on conflict do nothing`,
        [account, row.id, row.run_id],
      );

    // 1b) 请求关了以后没有别的待办、也不在执行中的任务，按中断收尾
    const stranded = (
      await client.query(
        // 只有「确实等超时」才收尾：刚批准、正在续接的那一轮不能被当成残留，
        // 否则批准后紧接着的一次收件箱刷新就会把它误标成 interrupted。
        `update run set state='interrupted', ended_at=now()
          where account_id=$1 and state='waiting' and ended_at is null
            and not exists (select 1 from approval a where a.run_id=run.id and a.state='pending')
            -- 刚批准、正在续接的那一轮不算残留：批准后的那次收件箱刷新
            -- 不能把还在跑的 run 误标成 interrupted。
            and not exists (
              select 1 from approval a
               where a.run_id=run.id and a.state='approved'
                 and a.decided_at > now() - interval '2 minutes')
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

/**
 * 服务启动时的核对（PRD 2.6）。
 *
 * 重启后上一轮的执行体都不在了：还停在执行中的任务补成中断，等回答但已超时的
 * 请求关掉。这里用管理员连接跨账户做，因为账户表对应用角色是强制 RLS 的。
 */
export async function reconcileOnStartup(
  pool: import("pg").Pool,
  options: { ttlMs?: number; now?: () => Date } = {},
): Promise<{ interruptedRuns: number; expiredRequests: number }> {
  const ttlMs = options.ttlMs ?? DEFAULT_ANSWER_TTL_MS;
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - ttlMs).toISOString();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const stale = await client.query(
      `update approval set state='expired'
        where state='pending' and created_at < $1 returning id, account_id, run_id`,
      [cutoff],
    );
    // 已结束任务名下还挂着的待批卡：跨账户一并关掉（启动时有管理员权限）。
    await client.query(
      `update approval set state='expired'
        where state='pending'
          and run_id in (select id from run
                          where state in ('completed','failed','cancelled','interrupted'))`,
    );

    const orphaned = await client.query(
      `update run set state='interrupted', ended_at=now()
        where state in ('queued','running') and ended_at is null
        returning id, account_id, dossier_id`,
    );
    const stranded = await client.query(
      `update run set state='interrupted', ended_at=now()
        where state='waiting' and ended_at is null
          and not exists (select 1 from approval a where a.run_id=run.id and a.state='pending')
        returning id, account_id, dossier_id`,
    );
    for (const row of [...orphaned.rows, ...stranded.rows]) {
      await client.query(
        `insert into event(account_id,dossier_id,run_id,kind,action,payload,dedupe_key)
         values($1::uuid,$2::uuid,$3::uuid,'run','run.interrupted',
                jsonb_build_object('reason','execution_lost','message','服务重启后这一段执行已不在，按中断收尾；可以重试。'),
                'lifecycle-startup:'||$3::text)
         on conflict do nothing`,
        [row.account_id, row.dossier_id, row.id],
      );
      await client.query(
        "update dsh_session set lease_run_id=null, lease_state='active', leased_until=null where account_id=$1 and lease_run_id=$2",
        [row.account_id, row.id],
      );
      await client.query(
        "update approval set state='expired' where account_id=$1 and run_id=$2 and state='pending'",
        [row.account_id, row.id],
      );
    }
    await client.query("commit");
    return {
      interruptedRuns: (orphaned.rowCount ?? 0) + (stranded.rowCount ?? 0),
      expiredRequests: stale.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
