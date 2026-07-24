import { getDb, listCases } from "@stopgap/db";
import { authenticateApiRequest } from "../../../lib/api-auth";
import { jsonOk, parseOr400 } from "../../../lib/api-response";
import { caseListSchema, listQuerySchema } from "../../../lib/api-schemas";

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

  const rows = await listCases(getDb(), query.data.limit);
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
