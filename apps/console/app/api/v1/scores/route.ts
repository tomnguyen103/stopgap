import { listScoresPage, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../lib/api-auth";
import { parseApiListQuery, pageMeta } from "../../../lib/api-list-query";
import { jsonOk } from "../../../lib/api-response";
import { scoreListSchema, toScoreResource } from "../../../lib/api-schemas";

/**
 * `GET /api/v1/scores` (ticket 19) — the current risk scores, scope `scores:read`.
 *
 * One row per signal: its LATEST snapshot, ranked on the deterministic scorer's number. Never on
 * `risk_signals.severity_score`, the ingest heuristic — publishing a different order than the
 * console shows for the same data is the failure this rule exists to prevent.
 *
 * The full history is deliberately not exposed here. A snapshot list is what a client needs to
 * rank and alert on; "what did this score look like in March" is an evidence question, and
 * evidence has its own endpoint shape rather than an unbounded history in a list response.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "scores:read");
  if (!auth.ok) return auth.response;

  const query = parseApiListQuery("scores", new URL(request.url));
  const orgId = auth.key.orgId;
  const page = await withOrgDb(orgId, (db) => listScoresPage(db, orgId, query));
  return jsonOk(
    scoreListSchema.parse({
      scores: page.rows.map(toScoreResource),
      page: pageMeta(query, page.total),
    }),
  );
}
