import "server-only";
import {
  appendAudit,
  findActiveApiKeyByPlaintext,
  getDb,
  isApiScope,
  reserveApiKeyRequest,
  touchApiKeyUsed,
  type ApiKeyRow,
  type ApiScope,
} from "@stopgap/db";
import { assertMutationAllowed, DemoReadOnlyError } from "@stopgap/demo";
import { jsonError } from "./api-response";

/**
 * API-key authentication and scope enforcement (PHASE6 §6.7) — the single gate every `/api/v1`
 * route runs first. The console's own mutations go through `requireRole` + an Auth.js session;
 * this is the same policy for a caller that has no session, only a key, and the two paths
 * deliberately share nothing but the audit chain they both write to: a bearer token must never be
 * able to mint a console session, and a console session must never be usable as an API key.
 *
 * HONEST NON-CONFIGURATION. There is no bootstrap key, no "allow all when nothing is configured",
 * no dev bypass. A deployment that has issued zero keys has an API that answers 401 to everything —
 * closed, not open-by-default. The only way in is a key an admin explicitly issued through
 * `/admin/api-keys`, which is exactly the property that makes "the MCP server needs a key now"
 * safe to state (§6.7 acceptance) rather than a claim that quietly degrades to direct DB access.
 */

/** Rolling rate-limit window. One hour, matching `apiKeys.rateLimitPerHour` and the `Retry-After`. */
const RATE_WINDOW_MS = 60 * 60 * 1000;

/** Seconds a throttled client is told to wait — the full window, the only honest upper bound. */
const RETRY_AFTER_SECONDS = String(RATE_WINDOW_MS / 1000);

/**
 * One message for BOTH "no such key" and "revoked key". Distinguishing them would turn the API
 * into an oracle that confirms whether a stolen-looking token was ever real — useful only to
 * someone probing leaked strings. Same body, same status, same code path length.
 */
const UNAUTHENTICATED_MESSAGE =
  "missing or invalid API key: send `Authorization: Bearer <key>` with a key issued from /admin/api-keys";

export type ApiAuthResult = { ok: true; key: ApiKeyRow } | { ok: false; response: Response };

/** The bearer token in an `Authorization` header, or undefined if absent/malformed. */
function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;
  const match = /^Bearer +(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** The scopes a key row actually carries, dropping any value that is not a known scope. */
export function keyScopes(key: ApiKeyRow): ApiScope[] {
  return key.scopes.filter(isApiScope);
}

/**
 * Authenticate a request and enforce one required scope.
 *
 * The order is deliberate — authenticate, then authorize, then throttle:
 *  - 401 with `WWW-Authenticate: Bearer` when there is no usable key (missing header, malformed
 *    header, unknown key, revoked key). An API client gets this JSON, never an HTML sign-in
 *    redirect; that is why `/api/v1` is exempted in the middleware matcher.
 *  - 403 when the key is real but lacks the scope, naming the scope required. Telling an
 *    authenticated integrator which scope they need is not a leak — they already hold a valid
 *    credential, and the alternative is an operator guessing at checkbox combinations.
 *  - 429 with `Retry-After` when the key is over its hourly limit. Throttling comes LAST so an
 *    unauthenticated flood cannot consume a legitimate key's budget, and so a wrong-scope caller
 *    learns that fact instead of being told to come back in an hour.
 *
 * The rate reservation is the DB-backed sliding window (`reserveApiKeyRequest`), so the limit
 * holds across restarts and replicas rather than resetting with the process.
 */
export async function authenticateApiRequest(
  request: Request,
  requiredScope: ApiScope,
): Promise<ApiAuthResult> {
  const token = bearerToken(request);
  if (!token) {
    return { ok: false, response: unauthorized() };
  }

  // The key store IS Postgres, so an outage here is not an authentication failure — it is this
  // gate being unable to reach a verdict. Left unhandled it throws past `ApiAuthResult` and Next
  // answers 500 with an HTML page, breaking the envelope every other path upholds. It must also
  // never degrade to 401: telling an integrator their credential is invalid when the truth is
  // "the database is down" sends them to rotate a key that was fine, and a 401 is not retryable
  // while this condition is. 503, naming the store, is the honest answer.
  let key: ApiKeyRow | undefined;
  try {
    key = await findActiveApiKeyByPlaintext(token);
  } catch (err) {
    return { ok: false, response: storeUnavailable("verify the API key", err) };
  }
  if (!key) {
    return { ok: false, response: unauthorized() };
  }

  if (!keyScopes(key).includes(requiredScope)) {
    return {
      ok: false,
      response: jsonError(
        403,
        "forbidden",
        `this API key does not carry the "${requiredScope}" scope required by this endpoint`,
      ),
    };
  }

  // Same reasoning as the lookup, with one addition: a reservation that cannot be recorded must
  // NOT fall open. Admitting the request because the counter is unreachable would turn a database
  // blip into an unmetered window — the one moment the limit exists to cover.
  let reservation: { allowed: boolean; recent: number };
  try {
    reservation = await reserveApiKeyRequest(key.id, new Date(Date.now() - RATE_WINDOW_MS), key.rateLimitPerHour);
  } catch (err) {
    return { ok: false, response: storeUnavailable("record this request against the key's rate limit", err) };
  }
  if (!reservation.allowed) {
    return {
      ok: false,
      response: jsonError(
        429,
        "rate_limited",
        `this API key is limited to ${key.rateLimitPerHour} requests per hour and has used ${reservation.recent}`,
        { "Retry-After": RETRY_AFTER_SECONDS },
      ),
    };
  }

  // Best-effort usage stamp: operational metadata must never fail an authorized request. The
  // authoritative record of what the key did is the audit chain, not this column.
  await touchApiKeyUsed(key.id).catch(() => undefined);
  return { ok: true, key };
}

function unauthorized(): Response {
  return jsonError(401, "unauthorized", UNAUTHENTICATED_MESSAGE, { "WWW-Authenticate": "Bearer" });
}

/**
 * 503 for a key store this gate could not reach. The underlying error is logged, not echoed: a
 * driver error can carry connection strings and internal hostnames, and an unauthenticated caller
 * triggers this path, so the body says only WHICH step failed.
 */
function storeUnavailable(what: string, err: unknown): Response {
  console.error(`[api] key store unavailable while attempting to ${what}`, err);
  return jsonError(
    503,
    "conflict",
    `could not ${what}: the credential store is unavailable. This is not a problem with your key — retry shortly.`,
    { "Retry-After": "30" },
  );
}

/**
 * The audit `actor` label for a key. The acting principal IS the key — not the human who issued
 * it, and not a fabricated user session. Pairing this label with `actorUserId = key.createdByUserId`
 * records the honest two-part truth: "this integration acted, and this human is answerable for
 * having issued it". Claiming the issuing human as the actor would put a decision in the chain
 * that they did not personally make; claiming no one would lose the accountability trail entirely.
 */
export function apiKeyActorLabel(key: ApiKeyRow): string {
  return `api-key:${key.name}`;
}

/**
 * Apply the demo read-only gate to an API write, translating a refusal into 403 JSON.
 *
 * The console catches `DemoReadOnlyError` and renders its message; a route handler that let it
 * propagate would return a 500 — telling an integrator "the server broke" when the truth is "this
 * deployment is a read-only public demo and refused you on purpose". The distinction matters:
 * a 500 invites a retry, a 403 with the real message does not.
 */
export function demoGateOr403(action: string): Response | undefined {
  try {
    assertMutationAllowed(action);
    return undefined;
  } catch (err) {
    if (err instanceof DemoReadOnlyError) return jsonError(403, "forbidden", err.message);
    throw err;
  }
}

/**
 * Record an API write in the hash-chained audit chain, mirroring the console's
 * `recordPrivilegedAudit`. Same shape, different principal: `actor` is the KEY's label and
 * `actorUserId` the human who issued it (nullable), with `identitySource: "api-key"` in the detail
 * so a reader can tell a key-driven write from a session-driven one without inspecting the label.
 *
 * `apiKeyId`, `scope` and `endpoint` go in the detail because revocation is the only lever an
 * operator has over a leaked key, and pulling it requires answering "which key did this, through
 * which endpoint, under which scope" from the chain alone.
 *
 * These entries carry no `caseId`, so `appendAudit` does not dedupe them on `eventKey`; the key is
 * a stable descriptive label, and the NULL `caseId` keeps repeated writes distinct in the unique
 * index. Nothing here changes what any existing scheme hashes — this is an ordinary append.
 */
export async function recordApiAudit(
  key: ApiKeyRow,
  scope: ApiScope,
  endpoint: string,
  action: string,
  detail: Record<string, unknown>,
  eventKey: string,
): Promise<void> {
  await appendAudit(getDb(), {
    actor: apiKeyActorLabel(key),
    actorUserId: key.createdByUserId ?? undefined,
    action,
    detail: { ...detail, identitySource: "api-key", apiKeyId: key.id, scope, endpoint },
    eventKey,
  });
}
