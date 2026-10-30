import type pg from "pg";
import { ApiFailure } from "../api/errors";

export type SessionKey = {
  account: string;
  dossier: string;
  sessionId: string;
};

/** Register the dossier's kernel session the first time it is used. */
export async function ensureSession(
  client: pg.PoolClient,
  key: SessionKey & { homePath: string; mode?: string },
): Promise<void> {
  await client.query(
    `insert into dsh_session(account_id,dossier_id,session_id,home_path,mode)
     values($1,$2,$3,$4,$5)
     on conflict (account_id,dossier_id,session_id) do update set updated_at=now()`,
    [key.account, key.dossier, key.sessionId, key.homePath, key.mode ?? "read"],
  );
}

/**
 * Take the session's write lease for one run. A session is single-writer:
 * another run cannot write it until this one releases. The lease is per
 * session, so unrelated dossiers keep working. An unconfirmed release keeps
 * the lease held instead of silently letting a second process in.
 */
export async function leaseSession(
  client: pg.PoolClient,
  key: SessionKey & { run: string; ttlSeconds?: number },
): Promise<boolean> {
  const ttl = key.ttlSeconds ?? 900;
  const result = await client.query(
    `update dsh_session
       set lease_run_id=$4,
           lease_state='active',
           leased_until=now() + ($5 || ' seconds')::interval,
           updated_at=now()
     where account_id=$1 and dossier_id=$2 and session_id=$3
       and (lease_run_id is null
            or lease_run_id=$4
            or (lease_state='active' and leased_until < now()))
     returning id`,
    [key.account, key.dossier, key.sessionId, key.run, String(ttl)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function confirmRelease(
  client: pg.PoolClient,
  key: SessionKey & { run: string },
): Promise<boolean> {
  const result = await client.query(
    `update dsh_session
       set lease_run_id=null, lease_state='active', leased_until=null, updated_at=now()
     where account_id=$1 and dossier_id=$2 and session_id=$3 and lease_run_id=$4
     returning id`,
    [key.account, key.dossier, key.sessionId, key.run],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * The kernel process for this run could not be confirmed stopped. Keep the
 * session closed to other writers (no expiry-based takeover) while other
 * dossiers continue unaffected.
 */
export async function markReleaseUnconfirmed(
  client: pg.PoolClient,
  key: SessionKey & { run: string },
): Promise<void> {
  await client.query(
    `update dsh_session
       set lease_state='unconfirmed', leased_until=null, updated_at=now()
     where account_id=$1 and dossier_id=$2 and session_id=$3 and lease_run_id=$4`,
    [key.account, key.dossier, key.sessionId, key.run],
  );
}

/** Human recovery: only an explicit release clears an unconfirmed lease. */
export async function forceRelease(
  client: pg.PoolClient,
  key: SessionKey,
): Promise<void> {
  const result = await client.query(
    `update dsh_session
       set lease_run_id=null, lease_state='active', leased_until=null, updated_at=now()
     where account_id=$1 and dossier_id=$2 and session_id=$3
     returning id`,
    [key.account, key.dossier, key.sessionId],
  );
  if (!result.rowCount) throw new ApiFailure("SESSION_NOT_FOUND", 404, "会话不存在。");
}
