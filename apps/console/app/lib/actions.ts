"use server";

import { revalidatePath } from "next/cache";
import { getCaseByWorkflowId, getDb } from "@stopgap/db";
import {
  makeClient,
  resolveException,
  submitReview,
  type ExceptionResolution,
  type ReviewDecision,
} from "@stopgap/workflows";

/**
 * HITL actions (PROJECT_PLAN §2, §13 Phase 4). Every one of these signals the durable
 * workflow rather than writing case state directly: the workflow owns the state machine, so
 * a decision recorded straight into Postgres would be a lie the moment the workflow moved on.
 *
 * There is no authentication layer yet — the console is a single-tenant local app and the
 * reviewer identity below is a claim, recorded as such in the audit trail. Real principals
 * arrive with the auth work tracked in PHASE5-TODO.
 */

/** Placeholder reviewer identity until the auth layer exists. */
const REVIEWER = "pharmacist-console";

async function withClient<T>(fn: (client: Awaited<ReturnType<typeof makeClient>>["client"]) => Promise<T>): Promise<T> {
  const { client, connection } = await makeClient();
  try {
    return await fn(client);
  } finally {
    await connection.close();
  }
}

/** The dedup key behind a workflow id, so an action can address the case the page shows. */
async function keyForWorkflow(workflowId: string): Promise<string> {
  const row = await getCaseByWorkflowId(getDb(), workflowId);
  if (!row) throw new Error(`no case for workflow ${workflowId}`);
  return row.key;
}

export async function reviewCase(workflowId: string, decision: ReviewDecision): Promise<void> {
  const key = await keyForWorkflow(workflowId);
  await withClient((client) => submitReview(client, key, decision));
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/");
}

export async function resolveExceptionCase(
  workflowId: string,
  resolution: Omit<ExceptionResolution, "resolvedBy">,
): Promise<void> {
  const key = await keyForWorkflow(workflowId);
  await withClient((client) =>
    resolveException(client, key, { ...resolution, resolvedBy: REVIEWER }),
  );
  revalidatePath(`/cases/${encodeURIComponent(workflowId)}`);
  revalidatePath("/protocols");
}
