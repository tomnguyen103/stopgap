"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getCaseByWorkflowId, getDb } from "@stopgap/db";
import { assertMutationAllowed, isDemoMode, prepareDemoRun, type DemoRunResult } from "@stopgap/demo";
import { resolveException, startCase, submitReview, withTemporalClient } from "@stopgap/workflows";

/**
 * HITL actions (PROJECT_PLAN §2, §13 Phase 4). Every one of these signals the durable
 * workflow rather than writing case state directly: the workflow owns the state machine, so
 * a decision recorded straight into Postgres would be a lie the moment the workflow moved on.
 *
 * A server action is a public endpoint: anything reachable here is reachable by anyone who
 * can POST to this app. Inputs are therefore schema-validated rather than trusted, and the
 * reviewer identity is recorded as an unverified claim (`identitySource`) — the console has
 * no authentication layer, so asserting "a pharmacist approved this" would be a lie the audit
 * trail then preserves forever. Verified principals are tracked in PHASE5-TODO.
 */

/** Claimed reviewer identity until the auth layer exists. */
const REVIEWER = "pharmacist-console";

const reviewDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("edit"), editedDraft: z.string().min(1).max(20_000) }),
  z.object({ kind: z.literal("reject"), reason: z.string().min(1).max(2_000) }),
]);

const resolutionSchema = z.object({
  protocolBody: z.string().min(1).max(20_000),
  alternatives: z.array(z.string().min(1).max(200)).max(20),
  rationale: z.string().min(1).max(2_000),
});

const workflowIdSchema = z.string().min(1).max(200);

/** The dedup key behind a workflow id, so an action can address the case the page shows. */
async function keyForWorkflow(workflowId: string): Promise<string> {
  const row = await getCaseByWorkflowId(getDb(), workflowId);
  if (!row) throw new Error(`no case for workflow ${workflowId}`);
  return row.key;
}

export async function reviewCase(workflowId: string, decision: unknown): Promise<void> {
  // A public demo must not let a visitor approve clinical guidance, and there is no auth
  // layer to distinguish one visitor from a pharmacist — so in demo mode the answer is no.
  assertMutationAllowed("Approving or rejecting a case");
  const parsed = reviewDecisionSchema.parse(decision);
  const key = await keyForWorkflow(workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) => submitReview(client, key, parsed, REVIEWER));
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/");
}

export async function resolveExceptionCase(workflowId: string, resolution: unknown): Promise<void> {
  assertMutationAllowed("Resolving an exception");
  const parsed = resolutionSchema.parse(resolution);
  const key = await keyForWorkflow(workflowIdSchema.parse(workflowId));
  await withTemporalClient((client) =>
    resolveException(client, key, { ...parsed, resolvedBy: REVIEWER }),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/protocols");
}

/**
 * The one mutation demo mode allows: start a real case for one of the catalogue drugs
 * (PROJECT_PLAN §11). Rate limiting and the drug allow-list live in `@stopgap/demo`, because
 * they must hold for every caller and not just for whoever came through this button.
 */
export async function startDemoShortage(key: unknown): Promise<DemoRunResult> {
  // A server action is a public endpoint whether or not a button renders it, and outside the
  // demo there is no reason for anyone to open cases for three fixed drugs.
  if (!isDemoMode()) {
    return { ok: false, reason: "unknown-drug", message: "demo scenarios are not enabled" };
  }
  const prepared = await prepareDemoRun(z.string().min(1).max(120).parse(key));
  if (!prepared.ok) return prepared;
  const started = await withTemporalClient((client) => startCase(client, prepared.record));
  revalidatePath("/");
  return { ok: true, ...started };
}
