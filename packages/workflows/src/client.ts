import { getEnv } from "@stopgap/core/env";
import type { ShortageRecord } from "@stopgap/core";
import { workflowIdForKey } from "@stopgap/db";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  SHORTAGE_CASE_WORKFLOW,
  type CaseAcknowledgment,
  type CaseState,
  type ExceptionResolution,
  type ReviewDecision,
} from "./shared.js";
import type { shortageCaseWorkflow } from "./workflows.js";
import {
  acknowledgeSignal,
  exceptionResolvedSignal,
  resolvedSignal,
  reviewSignal,
  stateQuery,
} from "./workflows.js";

/** Deadline for the single readiness RPC — `/readyz` must answer, not hang. */
const READINESS_RPC_TIMEOUT_MS = 5_000;

/** Open a Temporal client against the configured address/namespace. */
export async function makeClient(): Promise<{ client: Client; connection: Connection }> {
  const env = getEnv();
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  return { client, connection };
}

/**
 * Run one operation against a short-lived Temporal client and always close the connection.
 * Every caller outside the worker (console server actions, MCP tools, scripts) goes through
 * this rather than repeating the connect/finally dance and eventually forgetting the finally.
 */
export async function withTemporalClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { client, connection } = await makeClient();
  try {
    return await fn(client);
  } finally {
    await connection.close();
  }
}

/**
 * Start (or return the existing) durable case workflow for a shortage. The workflow id is derived
 * from the OWNING ORG and the dedup key (PHASE6 §6.5), so re-detecting the same shortage is
 * idempotent: the conflict policy rejects a start while a case for that drug is still running, and
 * we treat that as "already open".
 *
 * WHY THE ORG BELONGS IN THE ID. Temporal ids are unique per namespace, not per tenant. Before
 * this pass every hospital short on heparin computed `case-heparin`, so the SECOND tenant's
 * detection would collide with the FIRST tenant's running workflow and be reported as "already
 * open" — one org silently suppressing another org's clinical case. `org-<orgId>-case-<key>` makes
 * the two independent, which is the engine-side half of the `(org_id, workflow_id)` unique index.
 *
 * `existingWorkflowId` is how a case that PREDATES the format change keeps working. Its row holds
 * the old `case-<key>` id and its workflow answers to that id — Temporal cannot rename an
 * execution — so a recurrence must reuse the stored value rather than mint a new one, or the same
 * drug would end up with two workflows and one case row pointing at only one of them. Callers that
 * already read the case row pass `row.workflowId`; callers opening a genuinely new case omit it.
 *
 * Reuse is allowed once the previous case reached a terminal state. Shortages recur — the
 * same drug goes short again months later — and that recurrence is exactly when the protocol
 * store pays off (the new case reuses the guidance the last one produced). Rejecting reuse
 * outright, as this did before Phase 3, made a drug's first case its only case forever.
 */
export async function startCase(
  client: Client,
  orgId: string,
  record: ShortageRecord,
  sources: ShortageRecord["source"][] = [record.source],
  existingWorkflowId?: string,
): Promise<{ workflowId: string; started: boolean }> {
  const workflowId = existingWorkflowId ?? workflowIdForKey(orgId, record.key);
  try {
    // By name, never by function reference: see SHORTAGE_CASE_WORKFLOW.
    await client.workflow.start<typeof shortageCaseWorkflow>(SHORTAGE_CASE_WORKFLOW, {
      args: [{ orgId, record, sources }],
      taskQueue: getEnv().TEMPORAL_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: "ALLOW_DUPLICATE",
      workflowIdConflictPolicy: "FAIL",
    });
    return { workflowId, started: true };
  } catch (err) {
    if (err instanceof WorkflowExecutionAlreadyStartedError) return { workflowId, started: false };
    throw err;
  }
}

/**
 * Signal a review decision to a case's workflow.
 *
 * Takes the workflow id the CASE ROW carries, never a recomputed one (PHASE6 §6.5). Ids minted
 * before this pass are `case-<key>`; ids minted after are `org-<orgId>-case-<key>`, and the running
 * execution answers only to the id it was started with. Recomputing here would therefore signal a
 * workflow that does not exist for every pre-migration case — a silent no-op on the one path a
 * pharmacist uses to approve clinical guidance. Callers resolve the case with
 * `getCaseByKey(db, orgId, key)` and pass `row.workflowId`, which is correct for both eras.
 */
export async function submitReview(
  client: Client,
  workflowId: string,
  decision: ReviewDecision,
  reviewer?: string,
  reviewerUserId?: string,
): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  // Overlay the caller-supplied identity onto the decision. The authenticated console passes
  // both a label and a real `users.id`; the CLI/MCP callers pass only a claimed label.
  const signed: ReviewDecision = {
    ...decision,
    ...(reviewer ? { reviewer } : {}),
    ...(reviewerUserId ? { reviewerUserId } : {}),
  };
  await handle.signal(reviewSignal, signed);
}

/**
 * Resolve an exception-queue case: the pharmacist's guidance becomes an approved protocol
 * version and the case continues from where it parked (PROJECT_PLAN §3B). Addressed by the case
 * row's stored workflow id — see `submitReview` for why that is not recomputed.
 */
export async function resolveException(
  client: Client,
  workflowId: string,
  resolution: ExceptionResolution,
): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(exceptionResolvedSignal, resolution);
}

export async function markResolved(client: Client, workflowId: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(resolvedSignal);
}

/**
 * Acknowledge an escalating case (PHASE6 §6.3): signal the durable workflow, which stops the
 * ladder and records the ack (DB + audit) with the authenticated `users.id`. The ack identity is
 * the console session's principal, never a client-supplied string.
 */
export async function acknowledgeCase(
  client: Client,
  workflowId: string,
  ack: CaseAcknowledgment,
): Promise<void> {
  const handle = client.workflow.getHandle(workflowId);
  await handle.signal(acknowledgeSignal, ack);
}

/**
 * Is Temporal reachable (PHASE6 §6.4 readiness)? Connects and asks for cluster system info, then
 * always closes the connection. Returns false instead of throwing so `/readyz` can report which
 * dependency is down rather than 500-ing — honest "not ready", never a faked healthy.
 *
 * The RPC carries its own deadline: `Connection.connect()` bounds the *connect*, but a server that
 * accepts the connection and then wedges would leave `/readyz` hanging instead of answering
 * `ready: false`.
 */
export async function checkTemporal(): Promise<boolean> {
  try {
    const { connection } = await makeClient();
    try {
      await connection.withDeadline(Date.now() + READINESS_RPC_TIMEOUT_MS, () =>
        connection.workflowService.getSystemInfo({}),
      );
      return true;
    } finally {
      await connection.close();
    }
  } catch {
    return false;
  }
}

export async function getCaseState(client: Client, workflowId: string): Promise<CaseState> {
  const handle = client.workflow.getHandle(workflowId);
  return handle.query(stateQuery);
}
