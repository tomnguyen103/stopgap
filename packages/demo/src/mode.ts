import { getEnv } from "@stopgap/core/env";
import { demoBudgetStatus } from "./budget.js";

/**
 * Demo-mode state for the console banner and the server-action guard (PROJECT_PLAN §11).
 *
 * `isDemoMode()` is the single place that decides whether this deployment is a public demo.
 * Everything that refuses a mutation reads it, so there is no second definition to drift.
 */

export function isDemoMode(): boolean {
  return getEnv().STOPGAP_DEMO_MODE === "on";
}

export interface DemoStatus {
  demoMode: boolean;
  spentUsd: number;
  capUsd: number;
  /** Over the cap the deployment answers on the free local model instead of the paid one. */
  overCap: boolean;
  /** The provider a call would be routed to right now, as far as the cap is concerned. */
  effectiveProvider: "configured" | "ollama (budget cap)";
}

export async function demoStatus(): Promise<DemoStatus> {
  const budget = await demoBudgetStatus();
  return {
    demoMode: isDemoMode(),
    spentUsd: budget.spentUsd,
    capUsd: budget.capUsd,
    overCap: budget.overCap,
    effectiveProvider: budget.overCap ? "ollama (budget cap)" : "configured",
  };
}

/** Thrown by the guard below; the console turns it into a message rather than a crash. */
export class DemoReadOnlyError extends Error {
  constructor(action: string) {
    super(
      `${action} is disabled in demo mode. This deployment is a read-only public demo — ` +
        `use "Run a shortage" to drive the real engine.`,
    );
    this.name = "DemoReadOnlyError";
  }
}

/** Refuse a mutating action when this deployment is a public demo. */
export function assertMutationAllowed(action: string): void {
  if (isDemoMode()) throw new DemoReadOnlyError(action);
}
