import { getEnv } from "@stopgap/core/env";
import { getDb, getLlmSpend, recordLlmSpend, type DailySpend } from "@stopgap/db";
import { addLlmSink, setBudgetGuard, type BudgetStatus } from "@stopgap/providers";

/**
 * Wires the provider layer's daily budget cap to durable spend accounting (PROJECT_PLAN §11).
 *
 * Two halves: every LLM call's cost is added to today's row, and every routing decision reads
 * that row back. Over the cap, routing falls back to the free local model — the demo degrades
 * to a smaller model instead of going dark, and the banner says so.
 *
 * Spend is read through a short TTL cache because routing happens on every LLM call and the
 * answer changes by fractions of a cent; a cap is a coarse control, and a database round trip
 * per call to enforce it would cost more than it saves.
 */

const CACHE_TTL_MS = 10_000;

let cached: { at: number; spend: DailySpend } | undefined;

/** Today's spend, cached briefly. Exported for the console banner. */
export async function currentSpend(force = false): Promise<DailySpend> {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL_MS) return cached.spend;
  const spend = await getLlmSpend(getDb());
  cached = { at: now, spend };
  return spend;
}

/** Today's spend against the configured cap. */
export async function demoBudgetStatus(): Promise<BudgetStatus> {
  const capUsd = getEnv().DEMO_DAILY_USD_CAP;
  const { usd } = await currentSpend();
  return { spentUsd: usd, capUsd, overCap: usd >= capUsd };
}

/**
 * Install both halves. Idempotent per process: calling twice would double-count every call,
 * so the second call is a no-op.
 */
let installed = false;
export function installDemoBudget(): boolean {
  if (installed) return false;
  installed = true;
  addLlmSink((record) => {
    // The write is fire-and-forget on purpose: accounting must not sit in the latency path of
    // a clinical call. A dropped write under-counts by one call's cost, which the cap tolerates.
    void recordLlmSpend(getDb(), record.usdCost)
      .then(() => {
        cached = undefined;
      })
      .catch((err) => console.error("[demo] spend record failed:", err));
  });
  setBudgetGuard(demoBudgetStatus);
  return true;
}

/** Test helper: forget the install flag and the cached read. */
export function resetDemoBudget(): void {
  installed = false;
  cached = undefined;
}
