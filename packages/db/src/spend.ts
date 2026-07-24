import { eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { llmSpend } from "./schema.js";

/**
 * Daily LLM spend accounting behind the demo budget cap (PROJECT_PLAN §11).
 *
 * The cap protects a public demo from an unbounded bill, so the accounting has to be
 * durable (a process-local counter resets on every deploy) and monotonic under concurrency
 * (two visitors run scenarios at once). Both come from a single upsert that adds to the row
 * inside the database rather than read-modify-writing it in Node.
 */

/** The UTC calendar day a spend record belongs to, as `YYYY-MM-DD`. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Add one call's cost to today's total. Creates the day row on first call. */
export async function recordLlmSpend(db: Db, usd: number, at: Date = new Date()): Promise<void> {
  const day = utcDay(at);
  await db
    .insert(llmSpend)
    .values({ day, usdCost: usd.toFixed(8), calls: 1 })
    .onConflictDoUpdate({
      target: llmSpend.day,
      set: {
        usdCost: sql`${llmSpend.usdCost} + ${usd.toFixed(8)}`,
        calls: sql`${llmSpend.calls} + 1`,
        updatedAt: new Date(),
      },
    });
}

export interface DailySpend {
  day: string;
  usd: number;
  calls: number;
}

/** Today's spend so far. Returns zeroes for a day with no calls yet. */
export async function getLlmSpend(db: Db, at: Date = new Date()): Promise<DailySpend> {
  const day = utcDay(at);
  const [row] = await db.select().from(llmSpend).where(eq(llmSpend.day, day)).limit(1);
  return { day, usd: row ? Number(row.usdCost) : 0, calls: row?.calls ?? 0 };
}
