import { listCases, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../lib/api-auth";
import { jsonOk, parseOr400 } from "../../../lib/api-response";
import { caseListSchema, listQuerySchema } from "../../../lib/api-schemas";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `GET /api/v1/cases` (PHASE6 §6.7) — the case list, scope `cases:read`.
 *
 * Reads the durable Postgres mirror, exactly like the console's list page. Nothing here reaches
 * Temporal: a list endpoint that opened a workflow connection per request would make the API's
 * availability depend on the worker's, and the list view has never needed in-flight agent output.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "cases:read");
  if (!auth.ok) return auth.response;

  const query = parseOr400(listQuerySchema, {
    limit: new URL(request.url).searchParams.get("limit") ?? undefined,
  });
  if (!query.ok) return query.response;

  const orgId = auth.key.orgId;
  const rows = await withOrgDb(orgId, (db) => listCases(db, orgId, query.data.limit));
  return jsonOk(
    caseListSchema.parse({
      cases: rows.map((row) => ({
        workflowId: row.workflowId,
        key: row.key,
        genericName: row.genericName,
        status: row.status,
        severity: row.severity,
        updatedAt: row.updatedAt.toISOString(),
      })),
    }),
  );
}
