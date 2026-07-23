import { defineConfig } from "vitest/config";

/**
 * Live-model eval suite (PROJECT_PLAN §8 golden dataset + injection tests), run separately
 * from `pnpm test`/`pnpm gate` via `pnpm eval`. Deliberately NOT part of the hard-blocking
 * local gate: real live-Ollama runs showed the same golden case can flip pass/fail between
 * identical runs even at temperature 0 (small quantized local model inference isn't fully
 * deterministic) — a regression gate that fails the whole build on that noise trains people
 * to ignore red. `pnpm eval` reports the golden-dataset pass rate; a consistent regression
 * (fails most/every run) is a real signal, a one-off flip on one case usually isn't.
 */
export default defineConfig({
  test: {
    include: ["packages/**/*.eval.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.next/**"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
