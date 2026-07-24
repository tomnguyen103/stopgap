import { authConfigured, getEnv } from "@stopgap/core";
import NextAuth, { type NextAuthResult } from "next-auth";
import { NextResponse, type NextMiddleware } from "next/server";
import { authConfig } from "./auth.config";

/**
 * Route protection (PHASE6 §6.1). Builds an `auth` from the EDGE-SAFE config only (no DB) and
 * gates every console route:
 *
 *  - Public demo (`STOPGAP_DEMO_MODE=on`) OR no IdP wired (`!authConfigured`) → allow through.
 *    The request is the anonymous read-only viewer; every mutation still fails `requireRole`, so
 *    "read-only" is the ceiling, and we never redirect to a Keycloak that does not exist (honest
 *    non-configuration, not faked auth). This also keeps the zero-config local gate/build green.
 *  - Otherwise (a real deployment with auth configured) → an unauthenticated request is
 *    redirected to the Keycloak sign-in.
 *
 * The matcher already exempts `/api/auth/*` (the login flow itself) and static assets.
 */
// Annotated to dodge TS2742 (see auth.ts) — the inferred `auth` type is not portably nameable.
const auth: NextAuthResult["auth"] = NextAuth(authConfig).auth;

// Annotated `NextMiddleware` to dodge TS2742 on the default export (see auth.ts). The `auth`
// wrapper's request carries `.auth` (the session), which a bare `NextMiddleware` type omits, so
// the cast bridges the two — runtime behaviour is unchanged.
const middleware: NextMiddleware = auth((req) => {
  const env = getEnv();
  if (env.STOPGAP_DEMO_MODE === "on" || !authConfigured(env)) return undefined;
  if (!req.auth) {
    const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }
  return undefined;
}) as unknown as NextMiddleware;

export default middleware;

export const config = {
  // Everything except the Auth.js endpoints and Next's static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
