import { closeDb } from "../client.js";
import { listProtocolVersions, draftProtocolVersion } from "../protocols.js";
import { SEED_ORG_ID } from "../orgs.js";
import { withOrgDb } from "../org-context.js";

/**
 * The one row the browser tier cannot run without: a DRAFTED protocol version in the seed org.
 *
 * `e2e/auth/landing.spec.ts` proves that a control for an action above the signed-in role renders
 * refused rather than hidden — and the only such control in the console is the director's
 * "Approve" on a drafted protocol version, seen by a pharmacist. With no drafted version there is
 * nothing to gate, so the spec FAILS rather than skips, deliberately: a skip would let the one
 * assertion covering that requirement vanish silently the day the fixture data changed, and the
 * tier would still report green.
 *
 * NOT THE DEMO SEEDER, and not part of it. That seeder refuses to run outside
 * `STOPGAP_DEMO_MODE=on` because its cases are fiction that must not appear beside real shortages —
 * but the auth half of the browser tier runs with demo mode OFF, against a console wired to a real
 * IdP, so it can never call it. This writes the one row that tier needs and nothing else.
 *
 * NO CASE, on purpose. `draftProtocolVersion` takes an optional `sourceCaseId`, so the fixture is a
 * protocol and a drafted version with no case attached: nothing fictional lands in a pharmacist's
 * review queue, which is the hazard the demo seeder's refusal exists to prevent. What it writes is
 * inert until somebody approves it.
 *
 * IDEMPOTENT. A second run finds the version already there and writes nothing, so `pnpm
 * test:browser` can be run repeatedly against the same database without stacking versions — and
 * without the version number the spec sees drifting between runs.
 */
const FIXTURE_KEY = "e2e-fixture-protocol";

export async function seedBrowserFixture(): Promise<{ written: boolean }> {
  return withOrgDb(SEED_ORG_ID, async (db) => {
    const existing = await listProtocolVersions(SEED_ORG_ID, FIXTURE_KEY, db);
    // Any version at all, not specifically a drafted one: the first version this writes is drafted,
    // and if a run of the tier ever approves it the answer is a fresh database, not a second row.
    if (existing.length > 0) return { written: false };

    await draftProtocolVersion(
      {
        orgId: SEED_ORG_ID,
        key: FIXTURE_KEY,
        title: "Browser-tier fixture — a drafted version for the approval gate",
        drugClass: "fixture",
        body: [
          "This protocol exists so the browser tier has a drafted version to gate on.",
          "It is not clinical guidance and names no real shortage.",
        ].join("\n"),
        alternatives: [],
        authoredBy: "e2e-fixture",
        rationale: "Written by pnpm test:browser so the above-role approval control has a target.",
      },
      db,
    );
    return { written: true };
  });
}

async function main() {
  // The opt-in is the SCRIPT, the way `pnpm demo:seed` is: running the browser tier against a
  // database is already the deliberate act. The guard that matters is the content — a protocol with
  // no case, plainly labelled a fixture — rather than an env var the same command would set anyway.
  const { written } = await seedBrowserFixture();
  console.log(
    written
      ? `[browser-fixture] wrote the drafted protocol version "${FIXTURE_KEY}" into the seed org`
      : `[browser-fixture] "${FIXTURE_KEY}" already has a version — nothing to write`,
  );
}

main()
  .catch((err) => {
    console.error("[browser-fixture] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
