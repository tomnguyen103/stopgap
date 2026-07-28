import { isRole, type Role } from "@stopgap/core";

/**
 * Which roles a caller ends up holding, as PURE functions over an OIDC profile and the rows in
 * `user_roles` — no token verification, no session, no database (unified-platform-spec, ticket 01).
 *
 * Extracted from `auth.ts` so the rule can be asserted offline. It runs once per login, in the
 * Auth.js `jwt` callback, and what it returns is baked into the JWT that every subsequent
 * authorization check reads — so a mistake here is not a rendering bug, it is the wrong person
 * holding `admin` for the life of a token.
 */

/**
 * Realm roles asserted by the IdP token (`realm_access.roles`), filtered to the roles THIS build
 * knows.
 *
 * The filter is the security boundary, not tidiness. A Keycloak realm is shared infrastructure: it
 * carries built-in roles (`offline_access`, `uma_authorization`) and roles belonging to every other
 * client on it, and any of those could collide with a name this application later introduces.
 * Taking only known roles means the IdP can hand this deployment a role it has never heard of and
 * nothing happens.
 *
 * Total by construction — every malformed shape yields `[]` rather than throwing. A throw in the
 * `jwt` callback is a failed login for a legitimate user; degrading means they sign in holding
 * whatever was granted locally, which is the fail-closed outcome.
 */
export function realmRolesFromProfile(profile: unknown): Role[] {
  const claim = (profile as { realm_access?: { roles?: unknown } })?.realm_access?.roles;
  if (!Array.isArray(claim)) return [];
  return claim.filter((r): r is Role => typeof r === "string" && isRole(r));
}

/**
 * The caller's effective roles: local grants first, then any realm role they add, de-duplicated.
 *
 * Local grants are filtered too, as belt-and-braces rather than as the boundary: `getUserRoles`
 * already filters what it reads out of `user_roles`, so today's only caller cannot present an
 * unknown role. The second check costs one `typeof` and makes this function total over its own
 * signature, which matters because it is now callable from anywhere — an unfiltered union would
 * carry a retired role into the token, where `roleSatisfies` looks it up in the rank, finds
 * nothing, and compares against `undefined`.
 *
 * An empty result is a legitimate outcome and is deliberately NOT back-filled with `viewer`:
 * `resolvePrincipal` already resolves a role-less caller to the anonymous read-only viewer, and
 * minting a role here would make the token assert something neither source granted.
 */
export function resolveRoles(localRoles: readonly Role[], profile: unknown): Role[] {
  const known = localRoles.filter((r): r is Role => typeof r === "string" && isRole(r));
  return Array.from(new Set([...known, ...realmRolesFromProfile(profile)]));
}
