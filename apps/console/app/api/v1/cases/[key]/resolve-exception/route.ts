import { getCaseByKey, withOrgDb } from "@stopgap/db";
import { resolveException } from "@stopgap/workflows";
import { authenticateApiRequest, demoGateOr403, recordApiAudit } from "../../../../../lib/api-auth";
import { jsonError, jsonOk, parseJsonBodyOr400 } from "../../../../../lib/api-response";
import { acceptedSchema, resolveExceptionSchema } from "../../../../../lib/api-schemas";
import { signalTemporalOr503 } from "../../../../../lib/api-temporal";

/**
 * TENANT SCOPE (PHASE6 §6.5): the KEY's org, `auth.key.orgId`, and never anything from the request.
 * A key is issued into one organization and can never act outside it — see `lib/api-auth.ts` for
 * why deriving the tenant from the credential rather than from a parameter is what makes the public
 * API tenant-safe. `withOrgDb` sets `app.current_org` for the transaction, so RLS backs the
 * explicit filters rather than merely coexisting with them.
 */

/**
 * `POST /api/v1/cases/{key}/resolve-exception` (PHASE6 §6.7) — scope `protocols:write`.
 *
 * The API twin of the console's `resolveExceptionCase` server action, and it runs the same gates in
 * the same order: authenticate + scope, then the demo read-only gate, then signal the durable
 * workflow. It SIGNALS rather than writing case state directly for the reason the console does —
 * the workflow owns the state machine, so a decision written straight into Postgres would be a lie
 * the moment the workflow moved on.
 *
 * The recorded resolver is `api-key:<name>` with the issuing human's `users.id` beside it. That is
 * the honest attribution: the key acted, and a named human is answerable for having issued it. We
 * do NOT dress the write up as a pharmacist session — an audit chain that claims a human made a
 * clinical decision they never saw is worse than no audit at all.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  const auth = await authenticateApiRequest(request, "protocols:write");
  if (!auth.ok) return auth.response;

  const refused = demoGateOr403("Resolving an exception");
  if (refused) return refused;

  const { key } = await params;
  const body = await parseJsonBodyOr400(request, resolveExceptionSchema);
  if (!body.ok) return body.response;

  // Confirm the case exists before signalling: a signal to a missing workflow id fails deep in the
  // Temporal client, and the caller deserves "no such case" rather than a transport error.
  const orgId = auth.key.orgId;
  const row = await withOrgDb(orgId, (db) => getCaseByKey(db, orgId, key));
  if (!row) return jsonError(404, "not_found", `no case for key "${key}"`);

  const { key: apiKey } = auth;
  // 503 rather than an unhandled throw: the case exists, so a failure here is the workflow engine
  // being unreachable, not the caller's error — and the audit append below must not run for a
  // signal that never landed.
  const signalled = await signalTemporalOr503((client) =>
    // Addressed by the id the ROW carries, so a pre-migration case is still reachable.
    resolveException(client, row.workflowId, {
      ...body.data,
      resolvedBy: `api-key:${apiKey.name}`,
      resolvedByUserId: apiKey.createdByUserId ?? undefined,
    }),
  );
  if (!signalled.ok) return signalled.response;

  await recordApiAudit(
    apiKey,
    "protocols:write",
    "POST /api/v1/cases/{key}/resolve-exception",
    "case.exception_resolved.api",
    { caseKey: row.key, workflowId: row.workflowId },
    // Stable, descriptive label — never a timestamp. These entries have a NULL `caseId`, and
    // Postgres treats NULLs as distinct in a unique index, so repeated writes each append.
    `case.exception_resolved.api.${row.workflowId}`,
  );

  return jsonOk(acceptedSchema.parse({ ok: true, key: row.key }), 202);
}
