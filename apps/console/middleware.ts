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
  // Everything except the Auth.js endpoints, the unauthenticated health/metrics endpoints
  // (Prometheus and orchestrators scrape them with no session, PHASE6 §6.4), the public API
  // (PHASE6 §6.7), and Next's static assets. Exempting healthz/readyz/metrics here is what lets a
  // scrape reach them even when auth is configured and every other route demands a Keycloak session.
  //
  // `api/v1` is exempt because it authenticates itself and must answer an unauthenticated caller
  // with `401 {"error":"unauthorized"}` — never a 302 to a Keycloak login page. An API client
  // cannot follow an HTML sign-in redirect; it would parse the login page as its response body and
  // report a nonsense error.
  //
  // Exempting it removes no protection, but the two surfaces under it gate DIFFERENTLY, and the
  // distinction is the whole reason this exemption is safe:
  //  - Every DATA route (`/api/v1/cases…`, `/api/v1/protocols…`, `/api/v1/shadow/stats`) calls
  //    `authenticateApiRequest` first and is closed by default — with no keys issued they all 401,
  //    in every deployment, demo included.
  //  - The two DOCUMENTATION routes (`/api/v1/docs`, `/api/v1/openapi.json`) hold no data and
  //    carry no API key. They gate on a console SESSION instead, via `docsAudienceAllowed()`
  //    (`app/lib/api-docs-gate.ts`), which mirrors this file's own stance: an authenticated
  //    principal passes, and so does anyone when demo mode is on or no IdP is configured, because
  //    there is no session to demand in those deployments. An auth-configured deployment refuses
  //    an unauthenticated reader with 401 — HTML from `/docs`, JSON from `/openapi.json`.
  matcher: [
    "/((?!api/auth|api/healthz|api/readyz|api/metrics|api/v1|_next/static|_next/image|favicon.ico).*)",
  ],
};
