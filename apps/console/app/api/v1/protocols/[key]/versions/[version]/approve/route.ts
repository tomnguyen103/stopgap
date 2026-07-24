import { approveProtocolVersion, listProtocolVersions, withOrgDb } from "@stopgap/db";
import { authenticateApiRequest, demoGateOr403, recordApiAudit } from "../../../../../../../lib/api-auth";
import { jsonError, jsonOk, parseJsonBodyOr400, parseOr400 } from "../../../../../../../lib/api-response";
import { approvedSchema, approveVersionSchema } from "../../../../../../../lib/api-schemas";
import { z } from "zod";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `POST /api/v1/protocols/{key}/versions/{version}/approve` (PHASE6 §6.7) — scope
 * `protocols:write`.
 *
 * The API twin of `approveProtocolVersionAction`. Addressed by `(key, version)` rather than by the
 * version's uuid, because a caller who reached here through `GET /api/v1/protocols/{key}` holds
 * version NUMBERS, not internal ids; making them round-trip through a lookup they cannot perform
 * would be a contract that only the console could satisfy.
 *
 * `approveProtocolVersion` reports `changed: false` when the version was already approved. The
 * audit append is skipped in that case for the same reason the console skips it: recording it
 * would put a second "approved" claim into the chain for an approval that never happened. The
 * response still returns 200 with `changed: false` — the caller's desired state holds, which is
 * not an error, but it is also not a new event.
 *
 * A SUPERSEDED version is the other outcome, and it is a 409, not a 500. `approveProtocolVersion`
 * throws for it because a superseded version is immutable history — approving it would resurrect
 * guidance the organization has already replaced. That is a legitimate answer to a legitimate
 * request whose premise went stale (the caller read the history, then someone approved a newer
 * version), so it belongs in the envelope as `conflict` rather than arriving as an HTML 500 that
 * tells an integrator the server broke. The match is narrow and anything else rethrows: a genuine
 * database failure must not be relabelled as the client's stale read.
 *
 * RATIONALE, honestly scoped. `rationale` is recorded in the AUDIT CHAIN entry for this approval —
 * it is NOT written to `protocol_versions.rationale`. That column holds the reasoning captured when
 * the version was DRAFTED, and overwriting it at approval time would silently rewrite the author's
 * words under the approver's name. Keeping `approveProtocolVersion`'s signature unchanged is
 * deliberate: the console and this route must approve through exactly one code path, and a second
 * parameter only this caller passes would be the beginning of two. The schema's own OpenAPI
 * description states where the value lands, so no caller has to infer it from a GET that will not
 * show it back.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const versionParamSchema = z.coerce.number().int().min(1);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string; version: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "protocols:write");
  if (!auth.ok) return auth.response;

  const refused = demoGateOr403("Approving a protocol version");
  if (refused) return refused;

  const { key, version } = await params;
  const parsedVersion = parseOr400(versionParamSchema, version);
  if (!parsedVersion.ok) return parsedVersion.response;

  const body = await parseJsonBodyOr400(request, approveVersionSchema);
  if (!body.ok) return body.response;

  const orgId = auth.key.orgId;
  const target = (await withOrgDb(orgId, (db) => listProtocolVersions(orgId, key, db))).find(
    (v) => v.version === parsedVersion.data,
  );
  if (!target) return jsonError(404, "not_found", `no version ${parsedVersion.data} of protocol "${key}"`);

  const { key: apiKey } = auth;
  let row: Awaited<ReturnType<typeof approveProtocolVersion>>["row"];
  let changed: boolean;
  try {
    ({ row, changed } = await withOrgDb(orgId, (db) =>
      approveProtocolVersion(
        orgId,
        target.id,
        `api-key:${apiKey.name}`,
        apiKey.createdByUserId ?? undefined,
        db,
      ),
    ));
  } catch (err) {
    if (err instanceof Error && err.message.includes("is superseded and cannot be approved")) {
      return jsonError(
        409,
        "conflict",
        `version ${parsedVersion.data} of protocol "${key}" has been superseded by a later approved ` +
          "version and cannot be approved; re-read the version history and approve a draft instead",
      );
    }
    throw err;
  }

  if (changed) {
    await recordApiAudit(
      apiKey,
      "protocols:write",
      "POST /api/v1/protocols/{key}/versions/{version}/approve",
      "protocol.version_approved",
      { protocolKey: key, versionId: target.id, version: row.version, rationale: body.data.rationale, via: "api-key" },
      // Keyed by version id so it never collides with the console's `.direct.<id>` entries or the
      // workflow's own per-run approval entries.
      `protocol.version_approved.api.${target.id}`,
    );
  }

  return jsonOk(approvedSchema.parse({ ok: true, version: row.version, changed }));
}
