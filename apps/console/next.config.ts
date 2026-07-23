import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship raw TS (noEmit); let Next transpile them.
  transpilePackages: ["@stopgap/core", "@stopgap/db"],
  // DB access is server-only; never bundle postgres into a client chunk.
  serverExternalPackages: ["postgres"],
  eslint: { ignoreDuringBuilds: true },
  // Workspace packages use extensioned ESM imports (`./x.js`) over raw `.ts` sources
  // (moduleResolution: Bundler). Teach webpack to resolve `.js` specifiers to `.ts`.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
