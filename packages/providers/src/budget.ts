/**
 * Spend cap for the public demo (PROJECT_PLAN §11: "hard daily budget cap; over cap →
 * auto-switch to VPS Ollama").
 *
 * The provider layer owns the switch rather than the console, because the cap has to hold for
 * every caller — a scheduled poll opening cases at 03:00 spends the same dollars a visitor
 * does. What it deliberately does NOT do is fail the call: over the cap, routing falls back to
 * the local model, which is free and still answers. Degrading beats going dark.
 *
 * Where the numbers come from is left to the installer (the demo package reads the durable
 * daily-spend row) so this package keeps no database dependency.
 */

export interface BudgetStatus {
  spentUsd: number;
  capUsd: number;
  overCap: boolean;
}

export type BudgetGuard = () => Promise<BudgetStatus> | BudgetStatus;

let guard: BudgetGuard | undefined;

/** Install the guard consulted before each route decision. Returns a remover. */
export function setBudgetGuard(next: BudgetGuard): () => void {
  guard = next;
  return () => {
    if (guard === next) guard = undefined;
  };
}

export function clearBudgetGuard(): void {
  guard = undefined;
}

/**
 * Current budget status, or `undefined` when no cap is configured. A guard that throws is
 * treated as "no cap": an accounting outage must not silently downgrade every clinical call
 * to the small local model without anyone noticing — it logs instead.
 */
export async function budgetStatus(): Promise<BudgetStatus | undefined> {
  if (!guard) return undefined;
  try {
    return await guard();
  } catch (err) {
    console.error("[providers] budget guard failed; treating as under cap:", err);
    return undefined;
  }
}
