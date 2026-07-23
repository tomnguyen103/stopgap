/**
 * Replay the corpus through the live agents and write the shadow ledger.
 *
 *   pnpm --filter @stopgap/shadow replay            # whole corpus (slow: 2 model calls each)
 *   pnpm --filter @stopgap/shadow replay -- --limit 10
 *
 * Observational only: no case is touched, no comms sent, no protocol written.
 */
import { closeDb } from "@stopgap/db";
import { initObservability, flushTracing } from "@stopgap/observability";
import { REPLAY_CORPUS } from "../src/corpus.js";
import { runShadowEntry } from "../src/run.js";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? REPLAY_CORPUS.length : Number(process.argv[limitArg + 1]);
const entries = REPLAY_CORPUS.slice(0, Number.isFinite(limit) ? limit : REPLAY_CORPUS.length);

initObservability("stopgap-shadow-replay");
console.log(`[shadow] replaying ${entries.length}/${REPLAY_CORPUS.length} corpus entries`);

let done = 0;
for (const entry of entries) {
  try {
    await runShadowEntry(entry);
  } catch (err) {
    // One bad entry must not abandon the replay — the ledger is a sample, not a transaction.
    console.error(`[shadow] ${entry.id} failed:`, err instanceof Error ? err.message : err);
  }
  done += 1;
  if (done % 5 === 0) console.log(`[shadow] ${done}/${entries.length}`);
}

await flushTracing();
await closeDb();
console.log("[shadow] done");
