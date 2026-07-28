import { getSignalForApi, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonError, jsonOk } from "../../../../lib/api-response";
import { signalSchema, toSignalResource } from "../../../../lib/api-schemas";

/**
 * `GET /api/v1/signals/{key}` (ticket 19) — one risk signal by its dedupe key, scope
 * `signals:read`.
 *
 * A signal the key's org does not hold answers 404, not 403: the org filter is applied in the
 * query, so "another tenant has it" and "nobody has it" are indistinguishable from here — which is
 * the point. Distinguishing them would turn the endpoint into an oracle for what other hospitals
 * are tracking.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "signals:read");
  if (!auth.ok) return auth.response;

  const { key } = await context.params;
  const orgId = auth.key.orgId;
  const row = await withOrgDb(orgId, (db) => getSignalForApi(db, orgId, key));
  if (!row) return jsonError(404, "not_found", `no signal with dedupe key "${key}"`);
  return jsonOk(signalSchema.parse(toSignalResource(row)));
}
