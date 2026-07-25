import { getApprovedProtocol, listProtocolVersions, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonOk } from "../../../../lib/api-response";
import { protocolSchema } from "../../../../lib/api-schemas";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `GET /api/v1/protocols/{key}` (PHASE6 §6.7) — scope `protocols:read`.
 *
 * The organizational-memory lookup, in the same shape the MCP `get_protocol` tool has always
 * returned: the currently approved version plus every version's provenance (who authored, who
 * approved, why). An unwritten protocol is a 200 with `approved` absent and an empty history, not
 * a 404 — "we have no guidance for this drug" is a real, useful answer, and forcing a client to
 * treat it as an error would push them toward retry loops against a drug that simply has no
 * protocol yet.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "protocols:read");
  if (!auth.ok) return auth.response;

  const { key } = await params;
  const orgId = auth.key.orgId;
  const { approved, versions } = await withOrgDb(orgId, async (db) => ({
    approved: await getApprovedProtocol(orgId, key, db),
    versions: await listProtocolVersions(orgId, key, db),
  }));

  return jsonOk(
    protocolSchema.parse({
      approved: approved
        ? {
            version: approved.version.version,
            body: approved.version.body,
            alternatives: approved.version.alternatives,
            approvedBy: approved.version.approvedBy,
            rationale: approved.version.rationale,
          }
        : undefined,
      history: versions.map((version) => ({
        version: version.version,
        state: version.state,
        authoredBy: version.authoredBy,
        approvedBy: version.approvedBy,
        rationale: version.rationale,
      })),
    }),
  );
}
