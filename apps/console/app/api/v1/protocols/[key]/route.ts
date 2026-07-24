import { getApprovedProtocol, listProtocolVersions } from "@stopgap/db";
import { authenticateApiRequest } from "../../../../lib/api-auth";
import { jsonOk } from "../../../../lib/api-response";
import { protocolSchema } from "../../../../lib/api-schemas";

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
  const approved = await getApprovedProtocol(key);
  const versions = await listProtocolVersions(key);

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
