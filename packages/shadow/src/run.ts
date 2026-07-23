import { assessImpact, researchAlternatives } from "@stopgap/agents";
import { recordShadowRun } from "@stopgap/db";
import { routeModel } from "@stopgap/providers";
import type { ReplayEntry } from "./corpus.js";
import { scoreAgreement } from "./score.js";

/**
 * Run one replay entry through the live agents and write the result to the shadow ledger.
 *
 * Shadow runs are strictly observational: they never touch a case, never send comms, and
 * never write a protocol. That isolation is the whole point — the ledger has to be able to
 * say "the agent would have done X" for inputs where letting it act would have been unsafe.
 */
export async function runShadowEntry(entry: ReplayEntry): Promise<void> {
  // The provider this run is expected to use. It is resolved separately from the agents' own
  // internal routing, so a failover that happens *inside* one of the two agent calls is not
  // reflected here — the per-call truth lives in the Langfuse spans (ADR-0003). Good enough
  // for aggregating the ledger by provider; not a per-call attribution.
  const routed = await routeModel();
  const start = Date.now();
  const impact = await assessImpact(entry.record);
  const research = await researchAlternatives(entry.record);
  const latencyMs = Date.now() - start;

  const score = scoreAgreement(
    { severity: impact.severity, alternatives: research.alternatives },
    entry.baseline,
  );

  await recordShadowRun({
    corpusId: entry.id,
    key: entry.record.key,
    drugClass: entry.drugClass,
    proposedSeverity: impact.severity,
    proposedAlternatives: research.alternatives,
    baselineSeverity: entry.baseline.severity,
    // The corpus labels existence, not a specific substitute list (see corpus.ts) — a
    // placeholder name here would read as a real clinical recommendation in the ledger.
    baselineAlternatives: entry.baseline.hasAlternative ? ["<alternative exists>"] : [],
    agreement: score.agreement.toFixed(3),
    severityAgreed: score.severityAgreed,
    latencyMs,
    // Local Ollama is free, so 0 is the true cost of today's runs. Attributing real cost to a
    // paid-provider replay needs per-call token counts plumbed back from the telemetry sink
    // (they exist in the Langfuse span, not here) — logged as an open item rather than
    // guessed, because a made-up number in a cost column is worse than an obvious zero.
    usdCost: "0",
    provider: routed.info.name,
    modelId: routed.info.modelId,
  });
}
