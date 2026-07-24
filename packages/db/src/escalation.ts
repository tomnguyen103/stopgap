import { asc, eq } from "drizzle-orm";
import type { Db } from "./client.js";
import {
  acknowledgments,
  escalationPolicies,
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
