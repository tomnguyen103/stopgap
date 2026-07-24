import { defineConfig } from "vitest/config";

/**
 * The database-backed suites (PHASE6 §6.5), and ONLY those.
 *
 * A separate config rather than a flag on the default run, because these tests need something the
 * default run deliberately never needs: a live Postgres. The root `vitest.config.ts` excludes
 * `**\/*.e2e.test.ts` precisely so `pnpm gate` stays zero-config and offline; this config is the
 * explicit opt-in for the times you have a database in front of you.
 *
 *   pnpm test:rls
 *
 * Two suites, with different connection requirements — both stated in each file's header:
 *  - `rls.e2e.test.ts` needs `DATABASE_URL` to name a role the policies APPLY to, and refuses to
 *    run otherwise (a green isolation suite under a superuser proves nothing);
 *  - `migrations.e2e.test.ts` needs `DATABASE_URL_MAINTENANCE` to name the OWNER, because it
 *    creates and drops a throwaway database and applies the migrations as the role a deployment
 *    genuinely migrates as.
 *
 * `fileParallelism` is off: the suites seed and tear down fixed row ids, so two files racing over
 * the same rows would produce failures that look like isolation bugs and are not.
 */
export default defineConfig({
  test: {
    include: ["packages/db/src/rls.e2e.test.ts", "packages/db/src/migrations.e2e.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
