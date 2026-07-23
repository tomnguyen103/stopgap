import { getEnv } from "@stopgap/core/env";
import type { ShortageRecord } from "@stopgap/core";
import { workflowIdForKey } from "@stopgap/db";
import { Client, Connection } from "@temporalio/client";
import type { CaseState, ReviewDecision } from "./shared.js";
import { resolvedSignal, reviewSignal, shortageCaseWorkflow, stateQuery } from "./workflows.js";

/** Open a Temporal client against the configured address/namespace. */
export async function makeClient(): Promise<{ client: Client; connection: Connection }> {
  const env = getEnv();
  const connection = await Connection.connect({ address: env.TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: env.TEMPORAL_NAMESPACE });
  return { client, connection };
}

/**
 * Start (or return the existing) durable case workflow for a shortage. The workflow id is
 * derived from the dedup key, so re-detecting the same shortage is idempotent — Temporal's
 * `WorkflowIdReusePolicy` rejects a duplicate start and we treat that as "already open".
 */
export async function startCase(client: Client, record: ShortageRecord): Promise<string> {
  const workflowId = workflowIdForKey(record.key);
  await client.workflow.start(shortageCaseWorkflow, {
    args: [{ record, sources: [record.source] }],
    taskQueue: getEnv().TEMPORAL_TASK_QUEUE,
    workflowId,
    workflowIdReusePolicy: "REJECT_DUPLICATE",
  });
  return workflowId;
}

export async function submitReview(client: Client, key: string, decision: ReviewDecision): Promise<void> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  await handle.signal(reviewSignal, decision);
}

export async function markResolved(client: Client, key: string): Promise<void> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  await handle.signal(resolvedSignal);
}

export async function getCaseState(client: Client, key: string): Promise<CaseState> {
  const handle = client.workflow.getHandle(workflowIdForKey(key));
  return handle.query(stateQuery);
}
