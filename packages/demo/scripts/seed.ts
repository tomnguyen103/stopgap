import { closeDb } from "@stopgap/db";
import { seedDemoData } from "../src/seed.js";

/**
 * Nightly demo re-seed entrypoint: `pnpm --filter @stopgap/demo seed`.
 * Idempotent — see `seedDemoData` for why it updates rather than deletes.
 */
async function main() {
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
