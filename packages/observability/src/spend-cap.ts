import { getEnv } from "@stopgap/core/env";
import { getDb, getLlmSpend, recordLlmSpend, type DailySpend } from "@stopgap/db";
import { addLlmSink, setBudgetGuard, type BudgetStatus } from "@stopgap/providers";

/**
 * Durable spend accounting and the daily cap it feeds (PROJECT_PLAN §11).
 *
 * Two halves: every LLM call's cost is added to today's row, and every routing decision reads
 * that row back. Over the cap, routing is restricted to the free local provider.
 *
 * This lives with tracing rather than with the demo because the cap is not a demo feature —
 * a scheduled poll at 03:00 spends the same dollars a visitor does, so it has to hold for
 * every caller. It is off unless `LLM_DAILY_USD_CAP` is set: a deployment must opt into
 * "answer on the small local model past $N", never inherit it from a default.
 *
 * Spend is read through a short TTL cache because routing happens on every LLM call and the
 * answer moves by fractions of a cent. That makes the cap approximate under a concurrent
 * burst — it can overshoot by roughly one cache window of spend, which is the price of not
 * putting a database round trip in front of every clinical call.
 */

const CACHE_TTL_MS = 10_000;

let cached: { at: number; spend: DailySpend } | undefined;

/** Today's spend, cached briefly. */
export async function currentSpend(): Promise<DailySpend> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.spend;
  const spend = await getLlmSpend(getDb());
  cached = { at: now, spend };
  return spend;
}

/** Today's spend against the configured cap, or `undefined` when no cap is configured. */
export async function spendCapStatus(): Promise<BudgetStatus | undefined> {
  const capUsd = getEnv().LLM_DAILY_USD_CAP;
  if (capUsd === undefined) return undefined;
  const { usd } = await currentSpend();
  return { spentUsd: usd, capUsd, overCap: usd >= capUsd };
}

/**
 * Install both halves. Idempotent per process: calling twice would double-count every call.
 * Returns true when a cap is actually in force.
 */
let installed = false;
export function installSpendCap(): boolean {
  const capUsd = getEnv().LLM_DAILY_USD_CAP;
  if (!installed) {
    installed = true;
    addLlmSink((record) => {
      // Fire-and-forget on purpose: accounting must not sit in the latency path of a clinical
      // call. A dropped write under-counts by one call's cost, which the cap tolerates.
      void recordLlmSpend(getDb(), record.usdCost)
        .then(() => {
          cached = undefined;
        })
        .catch((err) => console.error("[observability] spend record failed:", err));
    });
    if (capUsd !== undefined) {
      setBudgetGuard(async () => {
        const status = await spendCapStatus();
        // Unreachable while the cap is configured, but the guard type demands a status and
        // inventing "over cap" here would downgrade every call on a config edit.
        return status ?? { spentUsd: 0, capUsd: Number.POSITIVE_INFINITY, overCap: false };
      });
    }
  }
  return capUsd !== undefined;
}

/** Test helper: forget the install flag and the cached read. */
export function resetSpendCap(): void {
  installed = false;
  cached = undefined;
}
