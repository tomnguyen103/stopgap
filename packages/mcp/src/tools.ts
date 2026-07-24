import { z } from "zod";
import {
  getApprovedProtocol,
  getCaseByWorkflowId,
  getDb,
  listCases,
  listProtocolVersions,
  workflowIdForKey,
} from "@stopgap/db";
import { getCaseState, submitReview, withTemporalClient } from "@stopgap/workflows";

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
 * There is no authentication here (see PHASE5-TODO), so the one mutating tool is OFF unless
 * `STOPGAP_MCP_ALLOW_REVIEW=1` is set. An unauthenticated MCP client that can approve a
 * clinical protocol defeats the HITL gate the rest of the system is built around, and the
 * hash-chained audit would then record the approval as a human decision.
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
  return withTemporalClient(async (client) => {
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
  });
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
export function reviewToolEnabled(): boolean {
  return process.env.STOPGAP_MCP_ALLOW_REVIEW === "1";
}

export async function reviewCaseTool(input: z.infer<typeof reviewInput>) {
  if (!reviewToolEnabled()) {
    return {
      signalled: false as const,
      reason:
        "review_case is disabled: this MCP server has no authentication, so approving a " +
        "clinical protocol through it is opt-in via STOPGAP_MCP_ALLOW_REVIEW=1",
    };
  }
  return withTemporalClient(async (client) => {
    // Reviewer identity is a claim recorded as such — same contract as the console.
    await submitReview(client, input.key, input.decision, "mcp-client");
    return { signalled: true as const, key: input.key, kind: input.decision.kind };
  });
}
