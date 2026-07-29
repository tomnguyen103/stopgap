import { and, desc, eq, lt } from "drizzle-orm";
import { dailyBriefs, type DailyBriefRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Daily briefs, per tenant (ticket 13).
 *
 * Scoped `Db` AND explicit `orgId` on every call, like every other helper here — RLS is the
 * backstop, and the explicit predicate is what makes a lost scope an empty page somebody reports
 * rather than silence.
 */

/**
 * Why a brief is not an ordinary one. A closed set, declared ONCE and shared by the writer, the
 * schema comment and the console label map — a third reason otherwise means three edits in three
 * packages, and the one that gets missed renders as a raw enum string to a director.
 */
export const DEGRADED_REASONS = {
  provider_unavailable: "No model provider could be reached",
  compliance_blocked: "Withheld by the compliance guard",
} as const;

export type DegradedReason = keyof typeof DEGRADED_REASONS;

export interface DailyBriefInput {
  briefDate: string;
  headline: string;
  changes: string[];
  newlyAtRisk: string[];
  needsReview: string[];
  signalKeys: string[];
  degradedReason?: DegradedReason | null;
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

/**
 * The brief BEFORE `briefDate` — what today's "what changed" is measured against.
 *
 * Excluding the day itself is what makes a re-run honest. The write is an upsert keyed on
 * (org, day), so a schedule that fires twice would otherwise read the row it just wrote as the
 * "previous" one, and every appeared/gone count would collapse to zero — a brief reporting a
 * quiet day precisely because it is the second attempt at a busy one.
 */
export async function previousDailyBrief(
  db: Db,
  orgId: string,
  briefDate: string,
): Promise<DailyBriefRow | undefined> {
  const [row] = await db
    .select()
    .from(dailyBriefs)
    .where(and(eq(dailyBriefs.orgId, orgId), lt(dailyBriefs.briefDate, briefDate)))
    .orderBy(desc(dailyBriefs.briefDate))
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
