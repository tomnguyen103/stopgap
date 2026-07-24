import { shadowStatsByClass, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonOk } from "../../../../lib/api-response";
import { shadowStatsSchema } from "../../../../lib/api-schemas";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `GET /api/v1/shadow/stats` (PHASE6 §6.7) — scope `shadow:read`.
 *
 * The same per-drug-class aggregates the shadow dashboard renders, aggregated in SQL. Exposed
 * WITHOUT the promotion decision the console attaches: `evaluatePromotion` encodes this
 * organization's gates, and publishing a "stage" through the API would invite an integrator to
 * treat one deployment's thresholds as the platform's contract. The numbers are the facts; the
 * gate that reads them is policy, and policy stays in the console.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "shadow:read");
  if (!auth.ok) return auth.response;

  const orgId = auth.key.orgId;
  const classes = await withOrgDb(orgId, (db) => shadowStatsByClass(orgId, db));
  return jsonOk(shadowStatsSchema.parse({ classes }));
}
