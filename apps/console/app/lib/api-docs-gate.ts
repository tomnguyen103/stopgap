import "server-only";
import { authConfigured, getEnv } from "@stopgap/core";
import { resolvePrincipal } from "./principal";

/**
 * Who may read the API documentation surface — `/api/v1/docs` and `/api/v1/openapi.json`
 * (PHASE6 §6.7: "serve Swagger UI at `/api/v1/docs` (admin or viewer-gated)").
 *
 * These two routes are the exception to the `/api/v1` rule. Every other route under that prefix
 * authenticates with a scoped API KEY; these authenticate with a console SESSION, because the
 * audience is a human reading a page in a browser, not an integration holding a bearer token — and
 * requiring a key to read the contract would mean nobody can generate a client until an admin has
 * already issued them one.
 *
 * Viewer minimum, not admin: the spec publishes shapes and status codes, never data, and every
 * operation it describes stays gated by its own scope check. The floor that matters is "not the
 * open internet", and `viewer` is that floor.
 *
 * The unauthenticated allowance mirrors the middleware's stance exactly (see `middleware.ts`):
 * only the public read-only demo may serve the docs without a session. An unconfigured non-demo
 * deployment fails closed, just like its console routes, instead of turning missing credentials
 * into a public surface.
 */
export async function docsAudienceAllowed(): Promise<boolean> {
  const env = getEnv();
  if (env.STOPGAP_DEMO_MODE === "on") return true;
  if (!authConfigured(env)) return false;
  return (await resolvePrincipal()).authenticated;
}

/** The message both routes give a caller they refuse — one wording, two renderings. */
export const DOCS_UNAUTHORIZED_MESSAGE =
  "this deployment requires a signed-in console session to read the API documentation; sign in at / and retry";
