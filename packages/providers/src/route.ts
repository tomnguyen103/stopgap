import { getEnv } from "@stopgap/core/env";
import { budgetStatus } from "./budget.js";
import { isProviderHealthy } from "./health.js";
import { providerInfo, resolveModel } from "./registry.js";
import type { ProviderName, ResolvedModel } from "./types.js";

export interface RouteResult extends ResolvedModel {
  /** True when the resolved provider differs from the one requested. */
  failedOver: boolean;
  requested: ProviderName;
  /** True when the daily spend cap forced the free local provider (PROJECT_PLAN §11). */
  budgetCapped: boolean;
}

/** The failover order: try the requested provider, then the other. Ollama is the anchor. */
function failoverOrder(requested: ProviderName): ProviderName[] {
  return requested === "gemini" ? ["gemini", "ollama"] : ["ollama", "gemini"];
}

/**
 * Pick a usable provider with runtime health-check failover (ADR-0002). Defaults to
 * `LLM_PROVIDER` from env. A stubbed or unhealthy provider is skipped in favor of the
 * next in the failover order. Throws only if no provider is usable.
 */
export async function routeModel(requested?: ProviderName): Promise<RouteResult> {
  const want = requested ?? getEnv().LLM_PROVIDER;
  // Over the daily cap, only the free local provider is allowed — the call still runs, on a
  // smaller model, and the result records that it was capped.
  const budget = await budgetStatus();
  const capped = budget?.overCap === true;
  const order = capped ? (["ollama"] as ProviderName[]) : failoverOrder(want);
  for (const name of order) {
    if (providerInfo(name).stub) continue;
    if (!(await isProviderHealthy(name))) continue;
    return {
      ...resolveModel(name),
      failedOver: name !== want,
      requested: want,
      budgetCapped: capped,
    };
  }
  throw new Error(
    `no usable LLM provider (requested ${want}${capped ? ", daily budget cap active" : ""}); ` +
      `checked ${order.join(", ")}. Is Ollama running, or GEMINI_API_KEY set?`,
  );
}
