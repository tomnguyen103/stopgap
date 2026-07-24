import { getCaseByWorkflowId, getDb, workflowIdForKey } from "@stopgap/db";
import { submitReview } from "@stopgap/workflows";
import { authenticateApiRequest, demoGateOr403, recordApiAudit } from "../../../../../lib/api-auth";
import { jsonError, jsonOk, parseJsonBodyOr400 } from "../../../../../lib/api-response";
import { acceptedSchema, reviewDecisionSchema } from "../../../../../lib/api-schemas";
import { signalTemporalOr503 } from "../../../../../lib/api-temporal";

/**
 * `POST /api/v1/cases/{key}/review` (PHASE6 §6.7) — scope `protocols:write`.
 *
 * The API twin of the console's `reviewCase` server action: the human-in-the-loop decision on an
 * agent-drafted protocol — approve it, approve an edited version of it, or reject it with a reason.
 *
 * WHY IT EXISTS. §6.7 asked to refactor the MCP server onto this API, not to shrink what programmatic
 * clients can do. The review decision is the ONE mutation the MCP server has exposed since
 * PROJECT_PLAN §4; without a REST endpoint behind it the refactor would have quietly deleted a
 * capability, which is a product change wearing a refactor's clothes. This endpoint is what makes the
 * MCP `review_case` tool honest again — and it is a strict improvement on what it replaces, because
 * the old tool's gate was an environment variable (`STOPGAP_MCP_ALLOW_REVIEW=1`) on whatever host ran
 * the process, and the gate now is a scope an administrator ticked in the console and can revoke.
 *
 * The gates run in the same order as every other write here: authenticate + scope, then the demo
 * read-only gate (a public demo visitor must not approve clinical guidance through the API any more
 * than through the console), then the signal.
 *
 * It SIGNALS rather than writing case state, because the workflow owns the review gate — a decision
 * written straight into Postgres would be a lie the moment the workflow moved on — and a transport
 * failure returns 503 rather than a fabricated acceptance.
 *
 * The recorded reviewer is `api-key:<name>` with the issuing human's `users.id` beside it. We do NOT
 * dress the decision up as a pharmacist's session: an audit chain that claims a named clinician
 * approved substitution guidance they never read is worse than no audit at all.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "protocols:write");
  if (!auth.ok) return auth.response;

  const refused = demoGateOr403("Approving or rejecting a case");
  if (refused) return refused;

  const { key } = await params;
  const body = await parseJsonBodyOr400(request, reviewDecisionSchema);
  if (!body.ok) return body.response;

  // Confirm the case exists before signalling, so a wrong key reads as "no such case" rather than
  // surfacing as a transport error from deep inside the Temporal client.
  const row = await getCaseByWorkflowId(getDb(), workflowIdForKey(key));
  if (!row) return jsonError(404, "not_found", `no case for key "${key}"`);

  const { key: apiKey } = auth;
  const signalled = await signalTemporalOr503((client) =>
    submitReview(client, row.key, body.data, `api-key:${apiKey.name}`, apiKey.createdByUserId ?? undefined),
  );
  if (!signalled.ok) return signalled.response;

  await recordApiAudit(
    apiKey,
    "protocols:write",
    "POST /api/v1/cases/{key}/review",
    "case.reviewed.api",
    // The decision KIND is recorded; the edited draft and rejection reason are not duplicated here —
    // they travel in the signal and land in the workflow's own audit entries, and copying them would
    // put the same clinical text in the chain twice under two different actors.
    { caseKey: row.key, workflowId: row.workflowId, decision: body.data.kind },
    // Stable, descriptive label — never a timestamp. These entries have a NULL `caseId`, and
    // Postgres treats NULLs as distinct in a unique index, so repeated reviews each append.
    `case.reviewed.api.${row.workflowId}`,
  );

  return jsonOk(acceptedSchema.parse({ ok: true, key: row.key }), 202);
}
