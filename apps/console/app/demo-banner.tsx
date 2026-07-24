import { demoStatus } from "@stopgap/demo";

/**
 * Demo banner (PROJECT_PLAN §11). Says three true things on every page: this is a read-only
 * demo, how much of today's LLM budget is spent, and — once the cap is hit — that answers are
 * now coming from the local model rather than the configured one. The last part matters:
 * a visitor comparing output quality deserves to know which model produced it.
 */
export async function DemoBanner() {
  const status = await demoStatus().catch(() => undefined);
  if (!status?.demoMode) return null;
  const budget = status.budget;
  return (
    <div className={budget?.overCap ? "demo-banner capped" : "demo-banner"}>
      <b>Read-only demo</b> — reviews and exception resolutions are disabled.
      {budget
        ? ` Today's model budget: $${budget.spentUsd.toFixed(3)} of $${budget.capUsd.toFixed(2)}.`
        : null}
      {budget?.overCap ? " Cap reached — now answering on the local Ollama model." : null}
    </div>
  );
}
