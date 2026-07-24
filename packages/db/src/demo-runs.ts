import { count, gte } from "drizzle-orm";
import type { Db } from "./client.js";
import { demoRuns } from "./schema.js";

/**
 * Demo scenario rate limiting (PROJECT_PLAN §11). Counting rows in the database rather than
 * a process-local counter means the limit survives a restart and holds across replicas.
 */

/** Record an accepted demo run. Written before the workflow starts, so a start that fails
 * still consumes its slot — the limit exists to bound work, not to reward failures. */
export async function recordDemoRun(db: Db, key: string): Promise<void> {
  await db.insert(demoRuns).values({ key });
}

export async function countDemoRunsSince(db: Db, since: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(demoRuns).where(gte(demoRuns.startedAt, since));
  return row?.n ?? 0;
}
