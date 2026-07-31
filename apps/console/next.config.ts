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
   * separate security ticket. Every style in the console is a stylesheet or a custom property;
   * nothing sets `style=` on an element, which is what makes `style-src 'self'` shippable.
   *
   * `'unsafe-inline'` for script-src is Next's requirement, not a choice: the App Router inlines
   * the Flight payload and the bootstrap script. Removing it needs per-request nonces through
   * middleware, which makes every route dynamic — a real cost on a console whose static shell is
   * deliberate. Recorded here rather than left implicit.
   *
   * HSTS is NOT set here. It belongs at the TLS terminator (Caddy): a header promising HTTPS,
   * served over a connection that may be plain HTTP behind a proxy, is a promise the application
   * cannot keep.
   */
  headers: () => {
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
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
    ].join("; ");

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
