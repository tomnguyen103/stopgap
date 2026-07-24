import { isRole, type Role } from "@stopgap/core";
import { getUserRoles, upsertUserByOidc } from "@stopgap/db";
import NextAuth, { type NextAuthResult } from "next-auth";
import { authConfig } from "./auth.config";
import { isSignInAllowed } from "./app/lib/sign-in-guard";

/**
 * Roles a caller holds come from EITHER source, unioned: locally-granted roles in `user_roles`
 * (the admin-managed store) and realm roles asserted by the IdP token (`realm_access.roles`,
 * how the seeded Keycloak demo users get theirs without a manual grant). Both are filtered to
 * the known `Role` set, so an unrecognized IdP role is ignored rather than trusted.
 */
function realmRolesFrom(profile: unknown): Role[] {
  const claim = (profile as { realm_access?: { roles?: unknown } })?.realm_access?.roles;
  if (!Array.isArray(claim)) return [];
  return claim.filter((r): r is Role => typeof r === "string" && isRole(r));
}

/**
 * Node-runtime Auth.js instance (PHASE6 §6.1). Spreads the edge-safe `authConfig` and adds the
 * DB-backed callbacks, which run only here (route handler / server actions), never in the edge
 * middleware. On sign-in the OIDC subject is upserted into `users` and the caller's roles are
 * baked into the JWT — so authorization checks read the token, not the DB, on every request.
 *
 * The identity written here is what flows into the audit chain: a server action reads
 * `session.user.id` (a real `users.id`) and threads it through the workflow signal, never a
 * client-supplied string.
 */
// Explicit `NextAuthResult` annotations work around TS2742 ("inferred type cannot be named"):
// with the `@/*` path map, tsc otherwise tries to name these via a non-portable
// `@/node_modules/...` path. This is the fix the Auth.js docs prescribe for v5 + noEmit.
const nextAuth = NextAuth({
  ...authConfig,
  callbacks: {
    // Admission gate (CWE-285): runs before jwt, so a disabled account is turned away instead of
    // being upserted and handed a token with full roles.
    async signIn({ profile }) {
      return isSignInAllowed(profile?.sub);
    },
    async jwt({ token, account, profile }) {
      // `account` is present only on the initial sign-in exchange. Upsert then, so we hit the DB
      // once per login rather than on every token refresh.
      if (account && profile?.sub) {
        const user = await upsertUserByOidc({
          oidcSubject: profile.sub,
          email: typeof profile.email === "string" ? profile.email : null,
          displayName: typeof profile.name === "string" ? profile.name : null,
        });
        token.userId = user.id;
        const dbRoles = await getUserRoles(user.id);
        token.roles = Array.from(new Set([...dbRoles, ...realmRolesFrom(profile)]));
        if (typeof profile.email === "string") token.email = profile.email;
        if (typeof profile.name === "string") token.name = profile.name;
      }
      return token;
    },
    session({ session, token }) {
      // Surface the local user id + roles on the session so `resolvePrincipal` and the guards
      // have a real principal. Roles are re-validated defensively (a stale token is not trusted
      // to carry a role the app no longer knows).
      if (typeof token.userId === "string") session.user.id = token.userId;
      session.user.roles = Array.isArray(token.roles)
        ? (token.roles.filter((r): r is Role => typeof r === "string" && isRole(r)))
        : [];
      return session;
    },
  },
});

export const handlers: NextAuthResult["handlers"] = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn: NextAuthResult["signIn"] = nextAuth.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuth.signOut;
