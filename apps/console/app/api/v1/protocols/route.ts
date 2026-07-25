import { listProtocols, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../lib/api-auth";
import { jsonOk, parseOr400 } from "../../../lib/api-response";
import { listQuerySchema, protocolListSchema } from "../../../lib/api-schemas";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `GET /api/v1/protocols` (PHASE6 §6.7 — "REST over … protocols (list/get/versions)") — scope
 * `protocols:read`.
 *
 * The index that makes `GET /api/v1/protocols/{key}` usable. Without it every protocol read is
 * addressed by a dedup key the caller must already possess, so an integration could only fetch
 * guidance for drugs it had somehow learned about elsewhere — the API would hold the organization's
 * substitution memory and offer no way to ask what is in it.
 *
 * A SUMMARY per protocol, not the full text: `approvedVersion` tells a client whether there is live
 * guidance at all (null means every version is still a draft) and the detail endpoint returns the
 * body plus the full version history. Inlining every protocol body here would make the common
 * "what do we have?" call proportional to the size of the whole store.
 *
 * Same `limit` query parameter as the case list, same bounds, for the reason list endpoints usually
 * share one: an integrator who has written pagination once against this API should not have to read
 * the spec again for the second collection.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request, "protocols:read");
  if (!auth.ok) return auth.response;

  const query = parseOr400(listQuerySchema, {
    limit: new URL(request.url).searchParams.get("limit") ?? undefined,
  });
  if (!query.ok) return query.response;

  const orgId = auth.key.orgId;
  const rows = await withOrgDb(orgId, (db) => listProtocols(orgId, query.data.limit, db));
  return jsonOk(
    protocolListSchema.parse({
      protocols: rows.map((row) => ({
        key: row.key,
        title: row.title,
        drugClass: row.drugClass,
        approvedVersion: row.approvedVersion,
        updatedAt: row.updatedAt.toISOString(),
      })),
    }),
  );
}
