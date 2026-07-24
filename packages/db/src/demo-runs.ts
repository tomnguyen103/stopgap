import { count, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { demoRuns } from "./schema.js";

/** Stable advisory-lock key for demo-run reservations (any constant unique to this concern). */
const DEMO_RUN_LOCK = 428_017;

/**
 * Demo scenario rate limiting (PROJECT_PLAN §11). Counting rows in the database rather than
 * a process-local counter means the limit survives a restart and holds across replicas.
 */

export async function countDemoRunsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(demoRuns).where(gte(demoRuns.startedAt, since));
  return row?.n ?? 0;
}

/**
 * Reserve a demo run slot atomically: within one serialized transaction, count the runs in
 * the window and insert this one only if the window has room. A separate count-then-insert
 * lets N concurrent requests all read `count < limit` and all insert, blowing past the cap;
 * the row lock makes each request see the others' inserts.
 *
 * Returns whether the slot was granted. A granted slot is consumed even if the caller's work
 * later fails — the limit bounds attempts, not successes.
 */
export async function reserveDemoRun(
  db: Db,
  key: string,
  since: Date,
  limit: number,
): Promise<{ allowed: boolean; recent: number }> {
  return db.transaction(async (tx) => {
    // A transaction-scoped advisory lock serializes reservations. Row locks can't: the race
    // is two callers both inserting NEW rows, and FOR UPDATE over existing rows does not block
    // a phantom insert. The lock releases on commit/rollback. (Same tool as the audit chain.)
    await tx.execute(sql`select pg_advisory_xact_lock(${DEMO_RUN_LOCK})`);
    const [row] = await tx
      .select({ n: count() })
      .from(demoRuns)
      .where(gte(demoRuns.startedAt, since));
    const recent = row?.n ?? 0;
    if (recent >= limit) return { allowed: false, recent };
    await tx.insert(demoRuns).values({ key });
    return { allowed: true, recent: recent + 1 };
  });
}
