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
  // Which provider actually served this run — resolved up front so the ledger row records
  // the same routing decision (including a Gemini→Ollama failover) that the agents used.
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
    // Cost per shadow run comes from the provider telemetry sink (Langfuse); local Ollama
    // runs are free, so this is 0 until the corpus is replayed against a paid provider.
    usdCost: "0",
    provider: routed.info.name,
    modelId: routed.info.modelId,
  });
}
