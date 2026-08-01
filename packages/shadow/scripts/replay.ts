/**
 * Replay the corpus through the live agents and write the shadow ledger.
 *
 *   pnpm --filter @stopgap/shadow replay            # whole corpus (slow: 2 model calls each)
 *   pnpm --filter @stopgap/shadow replay -- --limit 10
 *
 * Observational only: no case is touched, no comms sent, no protocol written.
 *
 * The ledger is per-organization (PHASE6 §6.5) — promotion gates read these aggregates, and one
 * hospital must not promote an agent on another hospital's evidence. A CLI has no session, so the
 * tenant comes from `STOPGAP_ORG_ID` and defaults to the seed org. Defaulting is honest here, unlike
 * in a request path: the operator running this command is choosing the deployment it points at.
 */
import { closeDb, hasShadowRunForReplay, SEED_ORG_ID, withOrgDb } from "@stopgap/db";
import { initObservability, flushTracing } from "@stopgap/observability";
import { REPLAY_CORPUS } from "../src/corpus.js";
import { runShadowEntry } from "../src/run.js";

const limitArg = process.argv.indexOf("--limit");
let limit = REPLAY_CORPUS.length;
if (limitArg !== -1) {
  // A malformed --limit must fail loudly: `--limit -1` would otherwise silently replay
  // everything except the last entry, and a missing value the whole corpus.
  limit = Number(process.argv[limitArg + 1]);
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`[shadow] --limit must be a non-negative integer (got "${process.argv[limitArg + 1]}")`);
    process.exit(1);
  }
}
const entries = REPLAY_CORPUS.slice(0, limit);
const orgId = process.env.STOPGAP_ORG_ID ?? SEED_ORG_ID;
const replayDay = new Date().toISOString().slice(0, 10);

initObservability("stopgap-shadow-replay");
console.log(
  `[shadow] replaying ${entries.length}/${REPLAY_CORPUS.length} corpus entries into org ${orgId}`,
);

let failures = 0;
try {
  let done = 0;
  for (const entry of entries) {
    try {
      const alreadyRecorded = await withOrgDb(orgId, (db) =>
        hasShadowRunForReplay(orgId, entry.id, replayDay, db),
      );
      if (alreadyRecorded) {
        console.log(`[shadow] ${entry.id} already recorded for ${replayDay}; skipping model calls`);
      } else {
        await runShadowEntry(orgId, entry, replayDay);
      }
    } catch (err) {
      // One bad entry must not abandon the replay — the ledger is a sample, not a transaction.
      console.error(`[shadow] ${entry.id} failed:`, err instanceof Error ? err.message : err);
      failures += 1;
    }
    done += 1;
    if (done % 5 === 0) console.log(`[shadow] ${done}/${entries.length}`);
  }
} finally {
  // Close in `finally` so a failed replay cannot exit holding the database connection.
  await flushTracing().catch(() => {});
  await closeDb();
}
if (failures > 0) {
  console.error(`[shadow] replay finished with ${failures} failed entr${failures === 1 ? "y" : "ies"}`);
  process.exitCode = 1;
} else {
  console.log("[shadow] done");
}
