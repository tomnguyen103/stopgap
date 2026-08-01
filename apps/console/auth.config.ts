import { getEnv } from "@stopgap/core/env";
import type { NextAuthConfig } from "next-auth";
import Keycloak from "next-auth/providers/keycloak";

const keycloakProvider = Keycloak({
  issuer: getEnv().KEYCLOAK_ISSUER,
  clientId: getEnv().KEYCLOAK_CLIENT_ID,
  // Empty (not a fake value) when unwired — keeps the "no fake success" stance.
  clientSecret: getEnv().KEYCLOAK_CLIENT_SECRET ?? "",
});

// Auth.js's default provider icon is hosted on authjs.dev. Keep the sign-in page self-contained so
// the console CSP can keep `img-src` limited to the app and data URLs in hospital networks.
const selfContainedKeycloakProvider = {
  ...keycloakProvider,
  style: { ...keycloakProvider.style, logo: "" },
};

/**
 * Edge-safe half of the Auth.js (NextAuth v5) config (PHASE6 §6.1). Deliberately imports NO
 * database code: the middleware builds its `auth` from THIS object and runs in the edge
 * runtime, where `@stopgap/db` (the `postgres` driver) cannot go. The Node-runtime half —
 * `auth.ts` — spreads this and adds the DB-backed sign-in callbacks.
 *
 * The IdP is Keycloak by default (the compose stack seeds a realm); swapping to Azure AD/Okta
 * is a URL/credential change to these three env vars, no code change. An unset client secret is
 * honest non-configuration (see `authConfigured`): the provider is still declared, but no one
 * can complete a sign-in. Demo mode may use the anonymous read-only viewer; a non-demo deployment
 * fails closed before a route renders.
 */
export const authConfig: NextAuthConfig = {
  // JWT sessions (§6.1): stateless, so no session table and the edge middleware can verify a
  // request without a DB round-trip. Roles are baked into the token at sign-in.
  session: { strategy: "jwt" },
  secret: getEnv().AUTH_SECRET,
  providers: [selfContainedKeycloakProvider],
};
