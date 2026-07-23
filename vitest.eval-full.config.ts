import { defineConfig, mergeConfig } from "vitest/config";
import evalConfig from "./vitest.eval.config.js";

/**
 * Full-corpus eval run (`pnpm eval:full`) — every golden case rather than the routine
 * stride. Setting EVAL_FULL here rather than as a shell prefix keeps the script working on
 * Windows, where `EVAL_FULL=1 vitest` is not valid shell.
 */
export default mergeConfig(
  evalConfig,
  defineConfig({ test: { env: { EVAL_FULL: "1" } } }),
);
