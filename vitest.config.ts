import { defineConfig } from "vitest/config";

export default defineConfig({
  // The console's components are `.tsx` and carry no `import React`, so they need the automatic
  // runtime. esbuild's default for `.tsx` is the classic `React.createElement` transform, which
  // would fail on every one of them regardless of what the include pattern says.
  esbuild: { jsx: "automatic" },
  test: {
    // `.test.tsx` as well as `.test.ts`: the presentational primitives are components, and a suite
    // that cannot collect a component test is a suite in which they are untestable by definition.
    include: ["packages/**/*.test.ts", "apps/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.e2e.test.ts", "e2e/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
