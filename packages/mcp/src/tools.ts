import { z } from "zod";
import {
  getApprovedProtocol,
  getCaseByWorkflowId,
  getDb,
  listCases,
  listProtocolVersions,
  workflowIdForKey,
} from "@stopgap/db";
import { getCaseState, makeClient, submitReview } from "@stopgap/workflows";

/**
 * The pipeline tools an MCP client (Claude, an internal agent, a CLI) can call against a
 * running Stopgap (PROJECT_PLAN §4).
 *
 * The tool surface is deliberately narrow. Reads are unrestricted; the only mutation exposed
 * is the pharmacist review decision, because that is the one action the platform is designed
 * to take instruction on. Opening cases, writing protocols directly, and sending comms are
 * NOT exposed: those belong to the workflow, and an MCP client that could write a protocol
 * without a case behind it would put unreviewed text into organizational memory.
 *
 * There is no authentication here either (see PHASE5-TODO) — the server is meant to be bound
 * to localhost alongside the console until the auth layer exists.
 */

export const listCasesInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

export async function listCasesTool(input: z.infer<typeof listCasesInput>) {
  const rows = await listCases(getDb(), input.limit);
  return rows.map((row) => ({
    workflowId: row.workflowId,
    key: row.key,
    genericName: row.genericName,
    status: row.status,
    severity: row.severity,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export const caseInput = z.object({ key: z.string().min(1) });

/** One case: the durable row plus the live workflow state (draft, alternatives). */
export async function getCaseTool(input: z.infer<typeof caseInput>) {
  const row = await getCaseByWorkflowId(getDb(), workflowIdForKey(input.key));
  if (!row) return { found: false as const };
  const { client, connection } = await makeClient();
  try {
    const live = await getCaseState(client, input.key).catch(() => undefined);
    return {
      found: true as const,
      workflowId: row.workflowId,
      key: row.key,
      genericName: row.genericName,
      status: live?.status ?? row.status,
      severity: live?.severity ?? row.severity,
      alternatives: live?.alternatives ?? [],
      draft: live?.draft ?? "",
      protocolSource: live?.protocolSource,
      exceptionReason: live?.exceptionReason,
    };
  } finally {
    await connection.close();
  }
}

/** The approved protocol for a drug, plus its version history — the memory lookup. */
export async function getProtocolTool(input: z.infer<typeof caseInput>) {
  const approved = await getApprovedProtocol(input.key);
  const versions = await listProtocolVersions(input.key);
  return {
    approved: approved
      ? {
          version: approved.version.version,
          body: approved.version.body,
          alternatives: approved.version.alternatives,
          approvedBy: approved.version.approvedBy,
          rationale: approved.version.rationale,
        }
      : undefined,
    history: versions.map((version) => ({
      version: version.version,
      state: version.state,
      authoredBy: version.authoredBy,
      approvedBy: version.approvedBy,
      rationale: version.rationale,
    })),
  };
}

export const reviewInput = z.object({
  key: z.string().min(1),
  decision: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("approve") }),
    z.object({ kind: z.literal("edit"), editedDraft: z.string().min(1) }),
    z.object({ kind: z.literal("reject"), reason: z.string().min(1) }),
  ]),
});

/** Submit the pharmacist decision on a case blocked at the HITL gate. */
export async function reviewCaseTool(input: z.infer<typeof reviewInput>) {
  const { client, connection } = await makeClient();
  try {
    await submitReview(client, input.key, input.decision);
    return { signalled: true as const, key: input.key, kind: input.decision.kind };
  } finally {
    await connection.close();
  }
}
