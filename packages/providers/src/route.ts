import { getEnv } from "@stopgap/core/env";
import { isProviderHealthy } from "./health.js";
import { providerInfo, resolveModel } from "./registry.js";
import type { ProviderName, ResolvedModel } from "./types.js";

export interface RouteResult extends ResolvedModel {
  /** True when the resolved provider differs from the one requested. */
  failedOver: boolean;
  requested: ProviderName;
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
  const order = failoverOrder(want);
  for (const name of order) {
    if (providerInfo(name).stub) continue;
    if (!(await isProviderHealthy(name))) continue;
    return { ...resolveModel(name), failedOver: name !== want, requested: want };
  }
  throw new Error(
    `no usable LLM provider (requested ${want}); checked ${order.join(", ")}. ` +
      `Is Ollama running, or GEMINI_API_KEY set?`,
  );
}
