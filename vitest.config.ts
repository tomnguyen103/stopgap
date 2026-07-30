import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.e2e.test.ts", "e2e/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
