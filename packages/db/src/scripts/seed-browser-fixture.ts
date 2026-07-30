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
 * NOT THE DEMO SEEDER, and not part of it. That seeder (`pnpm --filter @stopgap/demo seed`) refuses
 * to run outside `STOPGAP_DEMO_MODE=on`, because its cases are fiction that must not appear beside
 * real shortages — but the auth half of the browser tier runs with demo mode OFF, against a console
 * wired to a real IdP, so it can never call it. This writes the one row that tier needs, and
 * nothing else.
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

/** Loopback only. A parse failure counts as NOT local — an unreadable url is not a reassuring one. */
function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

async function main() {
  // GUARDS THE DATABASE, not the command. "The script is the opt-in" was the first version of this
  // and it defended the wrong thing: the hazard is not somebody running the seeder by accident, it
  // is running `pnpm test:browser` — a command they meant to run — with `DATABASE_URL` still
  // pointing at production. `SEED_ORG_ID` is not a sandbox there; migration 0013 backfilled the
  // deployment's real rows into it, so on a live install it is a hospital, and this would drop a
  // drafted protocol version into that facility's director approval queue, one click from becoming
  // approved clinical guidance.
  //
  // So the question asked is "is this database a local one", which is the question that actually
  // separates the safe case from the dangerous one. A remote test stack is a real thing, so there
  // is an override — but it has to be set deliberately, by someone who has just read this.
  if (process.env.NODE_ENV === "production") {
    console.error("[browser-fixture] NODE_ENV is production — refusing to write a test fixture");
    process.exitCode = 1;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (url && !isLocalDatabase(url) && process.env.STOPGAP_E2E_SEED_REMOTE !== "on") {
    console.error(
      `[browser-fixture] DATABASE_URL points at a non-local host — refusing. This writes into ` +
        `the SEED org, which on a real deployment holds that hospital's own rows. If you genuinely ` +
        `mean a remote TEST stack, set STOPGAP_E2E_SEED_REMOTE=on.`,
    );
    process.exitCode = 1;
    return;
  }
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
