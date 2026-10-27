/**
 * One-off business-data reset (user-authorised for this round).
 *
 * It removes the previous kernel's business records and files while keeping
 * everything needed to sign in again: accounts, auth links, provider
 * credentials and their vault references. The table list is explicit and
 * TRUNCATE runs WITHOUT CASCADE, so a missed relation fails loudly instead of
 * silently wiping a kept table.
 *
 * Run as the database owner (RLS revokes DELETE/TRUNCATE from the app role):
 *   tsx services/control/scripts/reset-business-data.ts --database-url <owner url> [--state-dir <dir>] [--apply]
 */
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

/** Business records only. Identity/configuration tables are deliberately absent. */
export const BUSINESS_TABLES = [
  "dsh_turn",
  "dsh_session",
  "usage_record",
  "mcp_run_revocation",
  "mcp_invocation",
  "mcp_approval",
  "mcp_credential",
  "runtime_model_request",
  "clarify_model_request",
  "paper_page_read",
  "paper_asset",
  "read_candidate",
  "read_clarify_run",
  "read_clarification",
  "card_decision",
  "promotion_decision",
  "os_observation",
  "os_usage",
  "os_binding",
  "gate",
  "artifact",
  "budget_hold",
  "memory_item",
  "budget_allocation",
  "delegation",
  "promotion",
  "approval",
  "event",
  "run",
  "budget_estimate",
  "mcp_run",
  "run_harness",
  "harness_proposal",
  "dossier_override",
  "bench_effective",
  "bench_tuning",
  "thread",
  "dossier",
  "http_request",
  "account_machine_operation",
  "credential_preflight_reconciliation",
  "account_machine",
] as const;

/** Files that belong to the previous kernel's business data. */
export const BUSINESS_PATHS = [
  "papers",
  "user-file-backups",
  "kernel",
  "audit",
  "billing",
  "hatchet",
  "real-model-upgrades",
  "account-credentials",
  "docker-client",
] as const;

export async function resetBusinessData(
  databaseUrl: string,
  options: { apply: boolean; stateDir?: string },
): Promise<{ tables: string[]; paths: string[] }> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const existing = new Set(
      (
        await pool.query(
          "select tablename from pg_tables where schemaname in ('public','reinlab_meta')",
        )
      ).rows.map((row) => row.tablename as string),
    );
    const present = BUSINESS_TABLES.filter((table) => existing.has(table));
    const missing = BUSINESS_TABLES.filter((table) => !existing.has(table));
    if (!options.apply) return { tables: present, paths: [] };
    // No CASCADE: a kept table that still references business rows aborts the run.
    await pool.query(`truncate table ${present.join(", ")}`);
    void missing;
    const removed: string[] = [];
    if (options.stateDir) {
      for (const entry of BUSINESS_PATHS) {
        const target = join(options.stateDir, entry);
        try {
          await readdir(target);
        } catch {
          continue;
        }
        await rm(target, { recursive: true, force: true });
        removed.push(target);
      }
    }
    return { tables: present, paths: removed };
  } finally {
    await pool.end();
  }
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const value = (name: string) => {
    const at = args.indexOf(name);
    return at < 0 ? undefined : args[at + 1];
  };
  const databaseUrl = value("--database-url");
  const stateDir = value("--state-dir");
  const apply = args.includes("--apply");
  if (!databaseUrl) {
    console.error(
      JSON.stringify({ code: "RESET_DATABASE_URL_REQUIRED", hint: "pass --database-url <owner url>" }),
    );
    process.exitCode = 2;
  } else {
    const result = await resetBusinessData(databaseUrl, { apply, stateDir });
    console.log(
      JSON.stringify({ code: "RESET_BUSINESS_DATA", apply, ...result }),
    );
  }
}
