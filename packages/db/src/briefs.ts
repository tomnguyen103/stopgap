import { and, desc, eq } from "drizzle-orm";
import { dailyBriefs, type DailyBriefRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Daily briefs, per tenant (ticket 13).
 *
 * Scoped `Db` AND explicit `orgId` on every call, like every other helper here — RLS is the
 * backstop, and the explicit predicate is what makes a lost scope an empty page somebody reports
 * rather than silence.
 */

export interface DailyBriefInput {
  briefDate: string;
  headline: string;
  changes: string[];
  newlyAtRisk: string[];
  needsReview: string[];
  signalKeys: string[];
  degradedReason?: string | null;
  model?: string | null;
  generatedAt: Date;
}

/** Write today's brief, restating it if the schedule already ran. */
export async function recordDailyBrief(
  db: Db,
  orgId: string,
  input: DailyBriefInput,
): Promise<DailyBriefRow> {
  const [row] = await db
    .insert(dailyBriefs)
    .values({
      orgId,
      briefDate: input.briefDate,
      headline: input.headline,
      changes: input.changes,
      newlyAtRisk: input.newlyAtRisk,
      needsReview: input.needsReview,
      signalKeys: input.signalKeys,
      degradedReason: input.degradedReason ?? null,
      model: input.model ?? null,
      generatedAt: input.generatedAt,
    })
    .onConflictDoUpdate({
      target: [dailyBriefs.orgId, dailyBriefs.briefDate],
      set: {
        headline: input.headline,
        changes: input.changes,
        newlyAtRisk: input.newlyAtRisk,
        needsReview: input.needsReview,
        signalKeys: input.signalKeys,
        degradedReason: input.degradedReason ?? null,
        model: input.model ?? null,
        generatedAt: input.generatedAt,
      },
    })
    .returning();
  if (!row) throw new Error(`daily brief for ${input.briefDate} was not written`);
  return row;
}

/** The most recent brief for this tenant, or undefined before the first one. */
export async function latestDailyBrief(db: Db, orgId: string): Promise<DailyBriefRow | undefined> {
  const [row] = await db
    .select()
    .from(dailyBriefs)
    .where(eq(dailyBriefs.orgId, orgId))
    .orderBy(desc(dailyBriefs.generatedAt))
    .limit(1);
  return row;
}

/** This tenant's recent briefs, newest first. */
export async function listDailyBriefs(db: Db, orgId: string, limit = 30): Promise<DailyBriefRow[]> {
  return db
    .select()
    .from(dailyBriefs)
    .where(eq(dailyBriefs.orgId, orgId))
    .orderBy(desc(dailyBriefs.generatedAt))
    .limit(limit);
}

/** One specific day's brief. */
export async function getDailyBrief(
  db: Db,
  orgId: string,
  briefDate: string,
): Promise<DailyBriefRow | undefined> {
  const [row] = await db
    .select()
    .from(dailyBriefs)
    .where(and(eq(dailyBriefs.orgId, orgId), eq(dailyBriefs.briefDate, briefDate)))
    .limit(1);
  return row;
}
