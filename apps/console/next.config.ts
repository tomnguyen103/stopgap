import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship raw TS (noEmit); let Next transpile them.
  transpilePackages: ["@stopgap/core", "@stopgap/db", "@stopgap/observability"],
  // DB access is server-only; never bundle postgres into a client chunk.
  serverExternalPackages: ["postgres"],
  // Workspace packages use extensioned ESM imports (`./x.js`) over raw `.ts` sources
  // (moduleResolution: Bundler). Teach webpack to resolve `.js` specifiers to `.ts`.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
  /**
   * Security headers (P4.5).
   *
   * `api/v1/docs` already names the missing CSP as a known hole, and this rebuild had to be
   * CSP-compatible anyway — which is why it belongs in the same programme rather than in a
   * separate security ticket.
   *
   * `'unsafe-inline'` is Next's requirement in BOTH `script-src` and `style-src`, not a choice.
   * The App Router inlines the Flight payload and the bootstrap script, and `next/font` injects
   * an inline `<style>` for its `@font-face` block. Removing either needs per-request nonces
   * through middleware, which makes every route dynamic — a real cost on a console whose static
   * shell is deliberate.
   *
   * What this rebuild DID buy is that no element carries a `style=` attribute (asserted by
   * `design-system-adoption.test.ts`), so tightening `style-src` later is a config change rather
   * than a sweep through the markup.
   *
   * HSTS is NOT set here. It belongs at the TLS terminator (Caddy): a header promising HTTPS,
   * served over a connection that may be plain HTTP behind a proxy, is a promise the application
   * cannot keep.
   */
  headers: () => {
    /*
      The IdP's origin, from the issuer the deployment is actually configured with.

      `form-action` is NOT a same-origin question here, and assuming it was is what made the first
      cut of this policy unshippable: Auth.js's sign-in page POSTs to `/api/auth/signin/keycloak`
      on this origin, and that response REDIRECTS to Keycloak. Chrome re-checks `form-action`
      against every hop of that redirect, so `form-action 'self'` blocked the POST outright and
      nobody could sign in at all. Caught by driving the flow, not by reading the policy:
      "Sending form data to '…/api/auth/signin/keycloak' violates … form-action 'self'".

      Empty when no IdP is configured — a demo deployment has no third origin to allow.
    */
    const idpOrigin = (() => {
      try {
        return process.env.KEYCLOAK_ISSUER ? new URL(process.env.KEYCLOAK_ISSUER).origin : "";
      } catch {
        return "";
      }
    })();

    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      `form-action 'self'${idpOrigin ? ` ${idpOrigin}` : ""}`,
      // Clickjacking, in the header modern browsers actually enforce. `X-Frame-Options` below is
      // for the ones that do not.
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      // `next/font` self-hosts and inlines its @font-face, so no font host is needed at all.
      "font-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
    ]
      .filter(Boolean)
      .join("; ");

    return Promise.resolve([
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // `strict-origin-when-cross-origin` still leaks the origin. This console's URLs carry
          // case and signal keys, so nothing about a path should reach a third party at all.
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ]);
  },
};

export default nextConfig;
