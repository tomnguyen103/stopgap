import { and, count, eq, gte, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { demoRuns } from "./schema.js";

/** Stable advisory-lock key for demo-run reservations (any constant unique to this concern). */
const DEMO_RUN_LOCK = 428_017;

/**
 * Demo scenario rate limiting (PROJECT_PLAN §11). Counting rows in the database rather than
 * a process-local counter means the limit survives a restart and holds across replicas. The
 * visitor id is an anonymous, server-issued cookie value; it is a quota key, not an identity or
 * authentication credential. Reservations enforce both a per-visitor limit and an aggregate
 * public-demo limit, so deleting the cookie cannot create unbounded paid-provider work.
 */

export async function countDemoRunsSince(
  db: Db,
  orgId: string,
  visitorId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(demoRuns)
    .where(
      and(
        eq(demoRuns.orgId, orgId),
        eq(demoRuns.visitorId, visitorId),
        gte(demoRuns.startedAt, since),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Reserve a demo run slot atomically: within one serialized transaction, count the runs in
 * the window and insert this one only if the window has room. A separate count-then-insert
 * lets N concurrent requests all read `count < limit` and all insert, blowing past the cap;
 * the row lock makes each request see the others' inserts.
 *
 * Returns whether the slot was granted. A granted slot is consumed even if the caller's work
 * later fails — the limits bound attempts, not successes. The aggregate limit is per demo tenant,
 * which is the deployment boundary for the anonymous public surface and remains visible through
 * the tenant-scoped connection/RLS contract.
 */
export async function reserveDemoRun(
  db: Db,
  orgId: string,
  visitorId: string,
  key: string,
  since: Date,
  visitorLimit: number,
  totalLimit: number,
): Promise<{ allowed: boolean; recent: number; totalRecent: number }> {
  return db.transaction(async (tx) => {
    // A transaction-scoped advisory lock serializes reservations. Row locks can't: the race
    // is two callers both inserting NEW rows, and FOR UPDATE over existing rows does not block
    // a phantom insert. The lock releases on commit/rollback. (Same tool as the audit chain.)
    // Keyed per demo tenant: all visitor reservations in that public surface serialize, so the
    // per-visitor count and aggregate count below see one another's inserts.
    await tx.execute(sql`select pg_advisory_xact_lock(${DEMO_RUN_LOCK}, hashtext(${orgId}))`);
    const [visitorRow] = await tx
      .select({ n: count() })
      .from(demoRuns)
      .where(
        and(
          eq(demoRuns.orgId, orgId),
          eq(demoRuns.visitorId, visitorId),
          gte(demoRuns.startedAt, since),
        ),
      );
    const recent = visitorRow?.n ?? 0;
    const [totalRow] = await tx
      .select({ n: count() })
      .from(demoRuns)
      .where(and(eq(demoRuns.orgId, orgId), gte(demoRuns.startedAt, since)));
    const totalRecent = totalRow?.n ?? 0;
    if (recent >= visitorLimit || totalRecent >= totalLimit) {
      return { allowed: false, recent, totalRecent };
    }
    await tx.insert(demoRuns).values({ orgId, visitorId, key });
    return { allowed: true, recent: recent + 1, totalRecent: totalRecent + 1 };
  });
}
