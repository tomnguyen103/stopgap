import { shadowStatsByClass } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonOk } from "../../../../lib/api-response";
import { shadowStatsSchema } from "../../../../lib/api-schemas";

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

  const classes = await shadowStatsByClass();
  return jsonOk(shadowStatsSchema.parse({ classes }));
}
