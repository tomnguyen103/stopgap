import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**", "**/*.e2e.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
