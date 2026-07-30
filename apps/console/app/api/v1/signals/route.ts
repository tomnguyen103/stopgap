import { listSignalsPageForApi, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../lib/api-auth";
import { parseApiListQuery, pageMeta } from "../../../lib/api-list-query";
import { jsonOk } from "../../../lib/api-response";
import { signalListSchema, toSignalResource } from "../../../lib/api-schemas";

/**
 * `GET /api/v1/signals` (ticket 19) — the risk-signal list, scope `signals:read`.
 *
 * TENANT SCOPE: the KEY's org, `auth.key.orgId`, and never anything from the request — the same
 * rule every `/api/v1` route follows, and the reason a leaked key is bounded to one hospital.
 *
 * Filtering and pagination use the CONSOLE's vocabulary (`api-list-query.ts`), so a link copied
 * out of a dashboard means the same thing here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "signals:read");
  if (!auth.ok) return auth.response;

  const query = parseApiListQuery("signals", new URL(request.url));
  const orgId = auth.key.orgId;
  const page = await withOrgDb(orgId, (db) => listSignalsPageForApi(db, orgId, query));
  return jsonOk(
    signalListSchema.parse({
      signals: page.rows.map(toSignalResource),
      page: pageMeta(query, page.total),
    }),
  );
}
