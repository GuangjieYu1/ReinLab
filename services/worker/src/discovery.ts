import type pg from "pg";
import { z } from "zod";
/** This pool is a different principal from both the application and the migrator. */
export class RecoveryDiscovery {
  constructor(private readonly pool: pg.Pool) {
    pool.on("error", () =>
      console.error(JSON.stringify({ code: "DISCOVERY_DATABASE_UNAVAILABLE" }))
    );
  }
  async assertSafe() {
    try {
      await this.pool.query("select public.reinlab_assert_discovery()");
    } catch {
      throw Error("UNSAFE_DISCOVERY_ROLE");
    }
  }
  async ceiling(): Promise<string | null> {
    const row = (
      await this.pool.query(
        "select id from public.account order by id desc limit 1"
      )
    ).rows[0];
    return row ? z.string().uuid().parse(row.id) : null;
  }
  async page(after?: string, size = 100, through?: string): Promise<string[]> {
    if (after !== undefined) z.string().uuid().parse(after);
    if (through !== undefined) z.string().uuid().parse(through);
    if (!Number.isInteger(size) || size < 1 || size > 250)
      throw Error("DISCOVERY_PAGE_INVALID");
    const rows = await this.pool.query(
      "select id from public.account where ($1::uuid is null or id>$1) and ($3::uuid is null or id<=$3) order by id limit $2",
      [after ?? null, size, through ?? null]
    );
    return rows.rows.map((row) => z.string().uuid().parse(row.id));
  }
}
