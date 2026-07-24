import { API_SCOPES } from "@stopgap/db";
import { getApiKeys } from "../../lib/data";
import { isActionAllowed } from "../../lib/authz";
import { resolvePrincipal } from "../../lib/principal";
import { ApiKeysAdmin } from "./api-keys-admin";

export const dynamic = "force-dynamic";

/**
 * API key management (PHASE6 §6.7). Issue a scoped key, see what exists, revoke. Gated to `admin`
 * server-side — the check here is defence in depth (both mutating actions call
 * `requireRole("manage_api_keys")` independently), so a non-admin who reaches the URL sees nothing
 * actionable.
 *
 * Revoked keys stay in the list. "Did we already revoke that integration?" is the question this
 * page exists to answer, and hiding revoked rows would make it unanswerable here.
 */
export default async function AdminApiKeysPage() {
  const principal = await resolvePrincipal();
  if (!isActionAllowed(principal.roles, "manage_api_keys")) {
    return (
      <>
        <h1>API keys</h1>
        <div className="empty">
          Admin only. Your roles: [{principal.roles.join(", ") || "none"}].
        </div>
      </>
    );
  }
  const keys = await getApiKeys();
  const live = keys.filter((k) => k.revokedAt === null).length;
  return (
    <>
      <h1>API keys</h1>
      <p className="sub">
        {live} live key{live === 1 ? "" : "s"} of {keys.length} issued · every request to{" "}
        <code>/api/v1</code> needs one, so with no live keys the public API is closed ·{" "}
        <a href="/api/v1/docs">API docs</a>
      </p>
      <ApiKeysAdmin
        keys={keys.map((k) => ({
          id: k.id,
          name: k.name,
          keyPrefix: k.keyPrefix,
          scopes: k.scopes,
          rateLimitPerHour: k.rateLimitPerHour,
          createdAt: k.createdAt.toISOString(),
          lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
          revokedAt: k.revokedAt?.toISOString() ?? null,
        }))}
        allScopes={[...API_SCOPES]}
      />
    </>
  );
}
