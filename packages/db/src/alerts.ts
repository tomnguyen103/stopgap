import { and, desc, eq, inArray } from "drizzle-orm";
import { alertEvents, alertRules, type AlertEventRow, type AlertRuleRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * Alert rules and their events, per tenant (ticket 12).
 *
 * Every helper takes a scoped `Db` AND an explicit `orgId`, and every predicate carries the org —
 * the belt-and-braces rule `docs/multi-tenancy.md` states for every query helper. RLS is the
 * backstop; the explicit filter is what makes a lost scope VISIBLE as an empty result rather than
 * silent.
 */

export interface AlertRuleInput {
  name: string;
  enabled?: boolean;
  riskDomain?: string | null;
  entityContains?: string | null;
  minSeverity: string;
  cooldownMinutes: number;
  channels: string[];
}

/** This tenant's rules. Ordered by name so a list a director reads does not reshuffle itself. */
export async function listAlertRules(db: Db, orgId: string): Promise<AlertRuleRow[]> {
  return db.select().from(alertRules).where(eq(alertRules.orgId, orgId)).orderBy(alertRules.name);
}

export async function createAlertRule(
  db: Db,
  orgId: string,
  input: AlertRuleInput,
): Promise<AlertRuleRow> {
  const [row] = await db
    .insert(alertRules)
    .values({
      orgId,
      name: input.name,
      enabled: input.enabled ?? true,
      riskDomain: input.riskDomain ?? null,
      entityContains: input.entityContains ?? null,
      minSeverity: input.minSeverity,
      cooldownMinutes: input.cooldownMinutes,
      channels: input.channels,
    })
    .returning();
  if (!row) throw new Error(`alert rule ${input.name} was not created`);
  return row;
}

/**
 * Edit a rule.
 *
 * Every field is written, including the nullable filters — a partial update that silently kept an
 * old `entityContains` would leave a director believing they had widened a rule they had not.
 */
export async function updateAlertRule(
  db: Db,
  orgId: string,
  ruleId: string,
  input: AlertRuleInput,
): Promise<AlertRuleRow | undefined> {
  const [row] = await db
    .update(alertRules)
    .set({
      name: input.name,
      enabled: input.enabled ?? true,
      riskDomain: input.riskDomain ?? null,
      entityContains: input.entityContains ?? null,
      minSeverity: input.minSeverity,
      cooldownMinutes: input.cooldownMinutes,
      channels: input.channels,
      updatedAt: new Date(),
    })
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
    .returning();
  return row;
}

/**
 * Delete a rule.
 *
 * Its events cascade with it. They are a record of what THAT rule decided, and a history of
 * decisions by a rule nobody can look up is a history nobody can act on — so it goes rather than
 * accumulating as orphaned rows.
 */
export async function deleteAlertRule(db: Db, orgId: string, ruleId: string): Promise<boolean> {
  const rows = await db
    .delete(alertRules)
    .where(and(eq(alertRules.orgId, orgId), eq(alertRules.id, ruleId)))
    .returning({ id: alertRules.id });
  return rows.length > 0;
}

/**
 * When each of these rules last FIRED — the input the cooldown decision needs.
 *
 * Only `fired` events count. A suppressed evaluation is a record that the rule stayed quiet, and
 * counting it would restart the cooldown every poll, which is a rule that never fires again.
 */
export async function lastFiredByRule(
  db: Db,
  orgId: string,
  ruleIds: string[],
): Promise<Record<string, string>> {
  if (ruleIds.length === 0) return {};
  const rows = await db
    .select({ ruleId: alertEvents.ruleId, firedAt: alertEvents.firedAt })
    .from(alertEvents)
    .where(
      and(
        eq(alertEvents.orgId, orgId),
        eq(alertEvents.outcome, "fired"),
        inArray(alertEvents.ruleId, ruleIds),
      ),
    )
    .orderBy(desc(alertEvents.firedAt));
  const out: Record<string, string> = {};
  // Newest first, so the FIRST row seen for a rule is its latest firing.
  for (const row of rows) {
    if (!out[row.ruleId]) out[row.ruleId] = row.firedAt.toISOString();
  }
  return out;
}

export interface AlertEventInput {
  ruleId: string;
  outcome: "fired" | "suppressed_cooldown";
  matchedCount: number;
  matchedKeys: string[];
  deliveries: { channel: string; delivered: boolean; reason?: string }[];
  idempotencyKey: string;
  firedAt: Date;
}

/**
 * Record what the evaluation decided, and what became of each send.
 *
 * Returns the rows that were genuinely NEW. That is the idempotency contract: a retried poll
 * conflicts on `(org, idempotency_key)`, gets an empty list back, and therefore sends nothing —
 * the send is guarded by the row, not by the caller remembering.
 */
export async function recordAlertEvents(
  db: Db,
  orgId: string,
  events: AlertEventInput[],
): Promise<AlertEventRow[]> {
  if (events.length === 0) return [];
  return (
    db
      .insert(alertEvents)
      .values(events.map((e) => ({ orgId, ...e })))
      // DO NOTHING, not DO UPDATE: a conflict means this notification already happened, and the
      // right response is to leave the original record exactly as it was written.
      .onConflictDoNothing({ target: [alertEvents.orgId, alertEvents.idempotencyKey] })
      .returning()
  );
}

/** Attach the send results to an event already recorded. */
export async function recordAlertDeliveries(
  db: Db,
  orgId: string,
  eventId: string,
  deliveries: { channel: string; delivered: boolean; reason?: string }[],
): Promise<void> {
  await db
    .update(alertEvents)
    .set({ deliveries })
    .where(and(eq(alertEvents.orgId, orgId), eq(alertEvents.id, eventId)));
}

/** This tenant's recent alert events, newest first — what a director tunes rules against. */
export async function listAlertEvents(
  db: Db,
  orgId: string,
  limit = 100,
): Promise<AlertEventRow[]> {
  return db
    .select()
    .from(alertEvents)
    .where(eq(alertEvents.orgId, orgId))
    .orderBy(desc(alertEvents.firedAt))
    .limit(limit);
}
