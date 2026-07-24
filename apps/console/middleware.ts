import { authConfigured, getEnv } from "@stopgap/core";
import NextAuth, { type NextAuthResult } from "next-auth";
import { NextResponse, type NextMiddleware } from "next/server";
import { authConfig } from "./auth.config";

/**
 * Route protection (PHASE6 §6.1). Gates every console route:
 *
 *  - Public demo (`STOPGAP_DEMO_MODE=on`) OR no IdP wired (`!authConfigured`) → PLAIN passthrough
 *    (`NextResponse.next()`), with NO Auth.js involved. The request is the anonymous read-only
 *    viewer; every mutation still fails `requireRole`, so read-only is the ceiling, and we never
 *    redirect to a Keycloak that does not exist (honest non-configuration, not faked auth). This
 *    also keeps the zero-config local gate/build green.
 *  - Otherwise (auth configured, demo off) → the Auth.js wrapper redirects an unauthenticated
 *    request to the Keycloak sign-in.
 *
 * The Auth.js `auth` wrapper is built and invoked LAZILY, only when auth is configured. Building
 * it eagerly and calling it on the demo/no-IdP path throws `MissingSecretError` with AUTH_SECRET
 * unset (the zero-config default), crashing the very path that must stay working — so that branch
 * must never touch Auth.js.
 *
 * The matcher already exempts `/api/auth/*` (the login flow itself) and static assets.
 */
let authMiddleware: NextMiddleware | undefined;

function ensureAuthMiddleware(): NextMiddleware {
  if (!authMiddleware) {
    // Annotated to dodge TS2742 (see auth.ts) — the inferred `auth` type is not portably nameable.
    const auth: NextAuthResult["auth"] = NextAuth(authConfig).auth;
    // The `auth` wrapper's request carries `.auth` (the session); the cast bridges it to the bare
    // `NextMiddleware` type — runtime behaviour is unchanged.
    authMiddleware = auth((req) => {
      if (!req.auth) {
        const signInUrl = new URL("/api/auth/signin", req.nextUrl.origin);
        signInUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
        return NextResponse.redirect(signInUrl);
      }
      return undefined;
    }) as unknown as NextMiddleware;
  }
  return authMiddleware;
}

const middleware: NextMiddleware = (request, event) => {
  const env = getEnv();
  // Demo or unconfigured: plain passthrough, no Auth.js (which would throw without a secret).
  if (env.STOPGAP_DEMO_MODE === "on" || !authConfigured(env)) return NextResponse.next();
  return ensureAuthMiddleware()(request, event);
};

export default middleware;

export const config = {
  // Everything except the Auth.js endpoints and Next's static assets.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico).*)"],
};
