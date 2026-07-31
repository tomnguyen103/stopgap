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
 * Six suites, with different connection requirements — both stated in each file's header:
 *  - `rls.e2e.test.ts` needs `DATABASE_URL` to name a role the policies APPLY to, and refuses to
 *    run otherwise (a green isolation suite under a superuser proves nothing);
 *  - `migrations.e2e.test.ts` needs `DATABASE_URL_MAINTENANCE` to name the OWNER, because it
 *    creates and drops a throwaway database and applies the migrations as the role a deployment
 *    genuinely migrates as;
 *  - `signals.e2e.test.ts` (tickets 06/09) needs `DATABASE_URL` to name the APPLICATION role: it
 *    asserts that the composite tenant keys refuse a cross-tenant reference, and under a role the
 *    policies do not apply to that assertion proves nothing.
 *  - `catalog.e2e.test.ts` (ticket 15) needs `DATABASE_URL` to name the APPLICATION role, for the
 *    same reason `rls.e2e.test.ts` does: it asserts that one tenant's catalog import is invisible
 *    to another, and under the owner that assertion passes without proving anything;
 *  - `public-lists.e2e.test.ts` (ticket 19) needs the APPLICATION role for the same reason: it is
 *    the only place the public API's list predicates run against real SQL.
 *  - `retention.e2e.test.ts` (ticket 18) needs the APPLICATION role too: it asserts that one
 *    tenant's cleanup cannot reach another tenant's rows, and that the audit chain still verifies
 *    after a sweep.
 *  - `tenant-keys.e2e.test.ts` (ticket 21) needs the APPLICATION role for the sharpest version of
 *    the same reason: it asserts that the composite keys REFUSE a row whose org and whose parent
 *    disagree. The owner bypasses the policies, and the insert it would then measure is not the
 *    insert the application makes.
 *
 * `fileParallelism` is off: the suites seed and tear down fixed row ids, so two files racing over
 * the same rows would produce failures that look like isolation bugs and are not.
 */
export default defineConfig({
  test: {
    include: [
      "packages/db/src/rls.e2e.test.ts",
      "packages/db/src/migrations.e2e.test.ts",
      "packages/db/src/signals.e2e.test.ts",
      "packages/db/src/catalog.e2e.test.ts",
      "packages/db/src/public-lists.e2e.test.ts",
      "packages/db/src/retention.e2e.test.ts",
      "packages/db/src/protocols.e2e.test.ts",
      "packages/db/src/tenant-keys.e2e.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
