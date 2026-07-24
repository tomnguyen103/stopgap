import { closeDb } from "@stopgap/db";
import { isDemoMode } from "../src/mode.js";
import { seedDemoData } from "../src/seed.js";

/**
 * Nightly demo re-seed entrypoint: `pnpm --filter @stopgap/demo seed`.
 * Idempotent — see `seedDemoData` for why it updates rather than deletes.
 */
async function main() {
  // Seeded cases are fiction with a `demo-seed-` key. On a real deployment they would sit in
  // the same list as shortages a pharmacist has to act on, so the seeder refuses to run there.
  if (!isDemoMode()) {
    console.log("[demo-seed] STOPGAP_DEMO_MODE is not \"on\" — refusing to seed demo cases");
    return;
  }
  const result = await seedDemoData();
  console.log(
    `[demo-seed] ${result.reseeded ? "re-seeded" : "seeded"} ${result.cases} cases, ` +
      `${result.protocolsWritten} protocol version(s) written`,
  );
}

main()
  .catch((err) => {
    console.error("[demo-seed] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
