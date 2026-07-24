import { jsonError } from "../../../lib/api-response";
import { docsAudienceAllowed, DOCS_UNAUTHORIZED_MESSAGE } from "../../../lib/api-docs-gate";
import { buildOpenApiDocument } from "../../../lib/api-schemas";

/**
 * `GET /api/v1/openapi.json` (PHASE6 §6.7) — the machine-readable contract.
 *
 * SESSION-GATED, viewer minimum (§6.7: "admin or viewer-gated"). A spec is not a secret — it
 * describes shapes and status codes, never data, and every operation it documents is itself gated by
 * a scoped key — so the gate here is not protecting the content. It is refusing to publish a map of
 * an internal hospital platform's write endpoints to the open internet, which is the difference
 * between "the endpoints are closed" and "nobody uninvited is even enumerating them".
 *
 * The gate is a console SESSION, not an API key: an integrator needs the contract in order to build
 * the client that will later carry a key, so requiring the key first is a loop. See
 * `api-docs-gate.ts` for why an unconfigured-IdP or demo deployment still answers.
 *
 * Refusal is the same `{ error, message }` envelope every other `/api/v1` route uses, because the
 * caller here is a code generator or a fetch in a terminal — machine-facing content deserves a
 * machine-readable refusal. (Its sibling `/api/v1/docs` answers in HTML for the opposite reason.)
 *
 * The document is derived from the same Zod schemas the routes validate with, so it cannot drift
 * from the enforcement.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (!(await docsAudienceAllowed())) {
    return jsonError(401, "unauthorized", DOCS_UNAUTHORIZED_MESSAGE);
  }
  return Response.json(buildOpenApiDocument());
}
