import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { alertEvents, alertRules, type AlertEventRow, type AlertRuleRow } from "./schema.js";
import { MIN_COOLDOWN_MINUTES } from "@stopgap/alerts";
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
  /** This tenant's chat webhook, when the rule notifies a channel. */
  chatWebhookUrl?: string | null;
  enabled?: boolean;
  riskDomain?: string | null;
  entityContains?: string | null;
  minSeverity: string;
  cooldownMinutes: number;
  channels: string[];
}

/**
 * A cooldown of zero is refused, not clamped.
 *
 * Zero means "tell me about every signal", which is the fifty-seven-notifications failure the
 * cooldown exists to prevent — and it would collapse the window arithmetic the idempotency key
 * depends on, so two firings in one minute would share a key and the second would vanish rather
 * than send. Refusing is the honest answer to a request the system cannot serve safely.
 */
/**
 * The values these text columns may hold.
 *
 * Postgres stores them as `text` — the same choice `severity` and `status` make elsewhere in this
 * schema — so the constraint has to live somewhere. Here, at the one door every writer passes
 * through, rather than in each caller: a rule stored with `minSeverity: 'urgent'` matches nothing
 * for the rest of its life and reports no error while doing it.
 */
const ALLOWED_SEVERITIES = ["low", "moderate", "high", "critical"] as const;
const ALLOWED_CHANNELS = ["email", "chat"] as const;
const ALLOWED_DOMAINS = ["shortage", "recall"] as const;

function assertRuleVocabulary(input: AlertRuleInput): void {
  if (!(ALLOWED_SEVERITIES as readonly string[]).includes(input.minSeverity)) {
    throw new Error(
      `alert rule severity must be one of ${ALLOWED_SEVERITIES.join(", ")} (got ${input.minSeverity})`,
    );
  }
  if (input.channels.length === 0) {
    throw new Error("alert rule must name at least one channel — one that reaches nobody is not a rule");
  }
  for (const channel of input.channels) {
    if (!(ALLOWED_CHANNELS as readonly string[]).includes(channel)) {
      throw new Error(
        `alert rule channel must be one of ${ALLOWED_CHANNELS.join(", ")} (got ${channel})`,
      );
    }
  }
  if (
    input.riskDomain !== undefined &&
    input.riskDomain !== null &&
    !(ALLOWED_DOMAINS as readonly string[]).includes(input.riskDomain)
  ) {
    throw new Error(
      `alert rule risk domain must be one of ${ALLOWED_DOMAINS.join(", ")} (got ${input.riskDomain})`,
    );
  }
  // A chat rule with no destination delivers nothing and records that it fired.
  if (input.channels.includes("chat") && !input.chatWebhookUrl) {
    throw new Error("a chat rule needs a webhook to deliver to");
  }
}

function assertCooldown(minutes: number): number {
  if (!Number.isInteger(minutes) || minutes < MIN_COOLDOWN_MINUTES) {
    throw new Error(
      `alert rule cooldown must be a whole number of minutes, at least ${String(MIN_COOLDOWN_MINUTES)}`,
    );
  }
  return minutes;
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
  assertRuleVocabulary(input);
  const [row] = await db
    .insert(alertRules)
    .values({
      orgId,
      name: input.name,
      enabled: input.enabled ?? true,
      riskDomain: input.riskDomain ?? null,
      entityContains: input.entityContains ?? null,
      minSeverity: input.minSeverity,
      cooldownMinutes: assertCooldown(input.cooldownMinutes),
      channels: input.channels,
      chatWebhookUrl: input.chatWebhookUrl ?? null,
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
  assertRuleVocabulary(input);
  const [row] = await db
    .update(alertRules)
    .set({
      name: input.name,
      enabled: input.enabled ?? true,
      riskDomain: input.riskDomain ?? null,
      entityContains: input.entityContains ?? null,
      minSeverity: input.minSeverity,
      cooldownMinutes: assertCooldown(input.cooldownMinutes),
      channels: input.channels,
      // OMITTED MEANS UNCHANGED, and only an explicit null clears it.
      //
      // A chat webhook is a bearer credential: whoever holds the URL can post into the room. With
      // `?? null` every editor had to send the stored secret back to keep it, which meant handing
      // it to whatever client was doing the editing. Preserving it here is what lets a console
      // tune a cooldown without ever being given the credential.
      ...(input.chatWebhookUrl === undefined ? {} : { chatWebhookUrl: input.chatWebhookUrl }),
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
 * When each of these rules last NOTIFIED SOMEBODY — the input the cooldown decision needs.
 *
 * Two filters, and both matter:
 *
 *  - `outcome = 'fired'`. A suppressed evaluation records that the rule stayed quiet; counting it
 *    would restart the cooldown every poll, which is a rule that never fires again.
 *  - `delivered_any`. A firing that reached nobody — a missing webhook, a 500, a process that died
 *    between recording and sending — did not happen, and must not start an hour of silence on the
 *    strength of it. The next poll retries.
 */
export async function lastFiredByRule(
  db: Db,
  orgId: string,
  ruleIds: string[],
): Promise<Record<string, string>> {
  if (ruleIds.length === 0) return {};
  // DISTINCT ON gives one row per rule in the database rather than fetching a rule's whole history
  // and discarding all but the newest in JavaScript.
  const rows = await db
    .selectDistinctOn([alertEvents.ruleId], {
      ruleId: alertEvents.ruleId,
      firedAt: alertEvents.firedAt,
    })
    .from(alertEvents)
    .where(
      and(
        eq(alertEvents.orgId, orgId),
        eq(alertEvents.outcome, "fired"),
        eq(alertEvents.deliveredAny, true),
        inArray(alertEvents.ruleId, ruleIds),
      ),
    )
    .orderBy(alertEvents.ruleId, desc(alertEvents.firedAt));
  return Object.fromEntries(rows.map((row) => [row.ruleId, row.firedAt.toISOString()]));
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
 * Record what the evaluation decided.
 *
 * Returns the row for EVERY event, whether it was inserted or already existed — because "already
 * existed" is not the same as "already delivered". A poll that recorded a firing and then died
 * before sending must be able to try again; returning nothing on conflict would have made that
 * firing permanently silent while its cooldown ran.
 *
 * The idempotency contract is therefore the row's `deliveredAny`, not the insert's outcome: the
 * caller sends only for a row that has not delivered yet, and a genuine retry after a successful
 * send finds `deliveredAny` true and stops.
 */
export async function recordAlertEvents(
  db: Db,
  orgId: string,
  events: AlertEventInput[],
): Promise<AlertEventRow[]> {
  if (events.length === 0) return [];
  // THE INSERT IS THE CLAIM, and `DO NOTHING` is what makes it one.
  //
  // With `DO UPDATE` the statement returned a row whether it inserted or merely restated one, so
  // two evaluations racing on the same window each got a row back and each sent — the cooldown
  // measured in the database, defeated by two processes reading it at once. `DO NOTHING` returns
  // ONLY the rows this statement actually inserted, so exactly one caller can go on to deliver.
  const claimed = await db
    .insert(alertEvents)
    .values(events.map((e) => ({ orgId, ...e })))
    .onConflictDoNothing({ target: [alertEvents.orgId, alertEvents.idempotencyKey] })
    .returning();

  // The rows somebody else already claimed still get their match count refreshed: the feed returns
  // more each poll and the record should say what was matched, even though this caller must not
  // send for it. Separate statement, and deliberately NOT returned.
  const claimedKeys = new Set(claimed.map((row) => row.idempotencyKey));
  const stale = events.filter((event) => !claimedKeys.has(event.idempotencyKey));
  for (const event of stale) {
    await db
      .update(alertEvents)
      .set({ matchedCount: event.matchedCount, matchedKeys: event.matchedKeys })
      .where(
        and(
          eq(alertEvents.orgId, orgId),
          eq(alertEvents.idempotencyKey, event.idempotencyKey),
          // Never overwrite a smaller count onto a larger one: two pollers arriving out of order
          // would otherwise make the record shrink.
          lt(alertEvents.matchedCount, event.matchedCount),
        ),
      );
  }
  return claimed;
}

/**
 * Attach the send results to an event already recorded.
 *
 * `deliveredAny` is derived here rather than passed in, so the flag the cooldown reads cannot
 * disagree with the per-channel results sitting beside it.
 */
export async function recordAlertDeliveries(
  db: Db,
  orgId: string,
  eventId: string,
  deliveries: { channel: string; delivered: boolean; reason?: string }[],
): Promise<void> {
  await db
    .update(alertEvents)
    .set({ deliveries, deliveredAny: deliveries.some((d) => d.delivered) })
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
