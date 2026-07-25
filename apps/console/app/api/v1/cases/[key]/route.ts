import { getCaseByKey, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonError, jsonOk } from "../../../../lib/api-response";
import { caseDetailSchema } from "../../../../lib/api-schemas";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `GET /api/v1/cases/{key}` (PHASE6 §6.7) — one case, scope `cases:read`.
 *
 * DELIBERATELY DB-BACKED ONLY. `getCaseTool` in the MCP server used to fold in live workflow state
 * (draft text, proposed alternatives) via `withTemporalClient`; this endpoint does not, for two
 * reasons. First, `withTemporalClient` opens and closes a fresh gRPC connection per call — an
 * acceptable cost for an occasional console page render, a bad one for a rate-limited endpoint an
 * integration polls. Second, and more important, it would couple the API's availability to the
 * worker's: a stopped Temporal would either 500 this route or (with the usual `.catch`) return a
 * response whose completeness silently varies with infrastructure state, which is precisely the
 * kind of quiet degradation this codebase refuses elsewhere.
 *
 * The consequence is stated rather than hidden: the response schema documents that in-flight agent
 * output is not included, and the MCP `get_case` tool's description says the same. An integration
 * that needs the live draft uses the console, which is where a human reviews it anyway.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "cases:read");
  if (!auth.ok) return auth.response;

  const { key } = await params;
  const orgId = auth.key.orgId;
  // BY KEY, never by a recomputed workflow id (PHASE6 §6.5): a case opened before ids became
  // org-qualified still stores `case-<key>`, so recomputing would 404 on cases that exist.
  const row = await withOrgDb(orgId, (db) => getCaseByKey(db, orgId, key));
  if (!row) return jsonError(404, "not_found", `no case for key "${key}"`);

  return jsonOk(
    caseDetailSchema.parse({
      workflowId: row.workflowId,
      key: row.key,
      genericName: row.genericName,
      status: row.status,
      severity: row.severity,
      source: row.source,
      sourceId: row.sourceId,
      ndcs: row.ndcs,
      lastNote: row.lastNote,
      openedAt: row.openedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
    }),
  );
}
