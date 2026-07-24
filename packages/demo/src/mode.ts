import { getEnv } from "@stopgap/core/env";
import { spendCapStatus } from "@stopgap/observability";
import type { BudgetStatus } from "@stopgap/providers";

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
  /** Undefined when no daily cap is configured for this deployment. */
  budget?: BudgetStatus;
}

export async function demoStatus(): Promise<DemoStatus> {
  return { demoMode: isDemoMode(), budget: await spendCapStatus() };
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
