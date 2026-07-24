import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  acknowledgments,
  escalationPolicies,
  userRoles,
  users,
  type AcknowledgmentRow,
  type EscalationPolicyRow,
  type EscalationStep,
} from "./schema.js";

/**
 * Escalation ladders + acknowledgments (PHASE6 §6.3). The escalation workflow reads a severity's
 * ladder and writes an acknowledgment when a human acks; the admin UI edits ladders. Kept a
 * small, deliberate surface, like `users.ts` — no scheduling logic lives here, only the durable
 * reads/writes the workflow and console need.
 */

/** The escalation ladder for a severity, or undefined when none is configured for it. */
export async function getEscalationPolicy(
  db: Db,
  severity: string,
): Promise<EscalationPolicyRow | undefined> {
  const [row] = await db
    .select()
    .from(escalationPolicies)
    .where(eq(escalationPolicies.severity, severity))
    .limit(1);
  return row;
}

/** Every configured ladder (admin management page), ordered by severity for a stable list. */
export async function listEscalationPolicies(db: Db): Promise<EscalationPolicyRow[]> {
  return db.select().from(escalationPolicies).orderBy(asc(escalationPolicies.severity));
}

/**
 * Create or replace a severity's ladder (admin). Upserts on the unique `severity` so editing an
 * existing ladder overwrites its steps rather than accumulating duplicate rows; `updatedAt` moves
 * so the console can show when the on-call ladder last changed.
 */
export async function upsertEscalationPolicy(
  db: Db,
  severity: string,
  steps: EscalationStep[],
): Promise<EscalationPolicyRow> {
  const [row] = await db
    .insert(escalationPolicies)
    .values({ severity, steps, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: escalationPolicies.severity,
      set: { steps, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error(`upsertEscalationPolicy: no row returned for ${severity}`);
  return row;
}

/**
 * The email addresses to page for one ladder tier. A step's `notify` is a role name
 * (`pharmacist`, `pharmacy_director`, `admin` in the seeded ladders), so the audience is whoever
 * currently holds that role — disabled accounts and role holders with no email on file are
 * excluded, because neither can be paged. An empty result is a real answer ("nobody holds this
 * role"), which the caller records as a non-delivery rather than silently paging someone else.
 */
export async function listRoleRecipients(db: Db, role: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, role), isNull(users.disabledAt), isNotNull(users.email)))
    .orderBy(asc(users.email));
  return [...new Set(rows.map((r) => r.email).filter((e): e is string => e !== null))];
}

/**
 * Record that a human acknowledged a case at a given escalation step. Idempotent on
 * `(caseId, step)` via `onConflictDoNothing`: a retried Temporal activity (the ack is written
 * from a durable workflow) or a double-click must not write two acks for the same tier. Returns
 * whether a NEW row was inserted, so the caller can skip an audit entry for an ack that was
 * already recorded.
 */
export async function recordAcknowledgment(
  db: Db,
  input: { caseId: string; userId: string; step: number },
): Promise<boolean> {
  const inserted = await db
    .insert(acknowledgments)
    .values({ caseId: input.caseId, userId: input.userId, step: input.step })
    .onConflictDoNothing({ target: [acknowledgments.caseId, acknowledgments.step] })
    .returning({ id: acknowledgments.id });
  return inserted.length > 0;
}

/** Every acknowledgment for a case, oldest first — the escalation timeline's "acked by whom". */
export async function listAcknowledgments(db: Db, caseId: string): Promise<AcknowledgmentRow[]> {
  return db
    .select()
    .from(acknowledgments)
    .where(eq(acknowledgments.caseId, caseId))
    .orderBy(asc(acknowledgments.step));
}
