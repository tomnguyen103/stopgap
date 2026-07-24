import { getEnv } from "@stopgap/core/env";
import type { ShortageRecord } from "@stopgap/core";
import { workflowIdForKey } from "@stopgap/db";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import {
  SHORTAGE_CASE_WORKFLOW,
  type CaseState,
  type ExceptionResolution,
  type ReviewDecision,
} from "./shared.js";
import type { shortageCaseWorkflow } from "./workflows.js";
import {
  exceptionResolvedSignal,
  resolvedSignal,
  reviewSignal,
  stateQuery,
} from "./workflows.js";

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
 * Start (or return the existing) durable case workflow for a shortage. The workflow id is
 * derived from the dedup key, so re-detecting the same shortage is idempotent: the conflict
 * policy rejects a start while a case for that drug is still running, and we treat that as
 * "already open".
 *
 * Reuse is allowed once the previous case reached a terminal state. Shortages recur — the
 * same drug goes short again months later — and that recurrence is exactly when the protocol
 * store pays off (the new case reuses the guidance the last one produced). Rejecting reuse
 * outright, as this did before Phase 3, made a drug's first case its only case forever.
 */
export async function startCase(
  client: Client,
  record: ShortageRecord,
  sources: ShortageRecord["source"][] = [record.source],
): Promise<{ workflowId: string; started: boolean }> {
  const workflowId = workflowIdForKey(record.key);
  try {
    // By name, never by function reference: see SHORTAGE_CASE_WORKFLOW.
    await client.workflow.start<typeof shortageCaseWorkflow>(SHORTAGE_CASE_WORKFLOW, {
      args: [{ record, sources }],
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

export async function submitReview(
  client: Client,
  key: string,
  decision: ReviewDecision,
  reviewer?: string,
): Promise<void> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  await handle.signal(reviewSignal, reviewer ? { ...decision, reviewer } : decision);
}

/**
 * Resolve an exception-queue case: the pharmacist's guidance becomes an approved protocol
 * version and the case continues from where it parked (PROJECT_PLAN §3B).
 */
export async function resolveException(
  client: Client,
  key: string,
  resolution: ExceptionResolution,
): Promise<void> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  await handle.signal(exceptionResolvedSignal, resolution);
}

export async function markResolved(client: Client, key: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  await handle.signal(resolvedSignal);
}

export async function getCaseState(client: Client, key: string): Promise<CaseState> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  return handle.query(stateQuery);
}
