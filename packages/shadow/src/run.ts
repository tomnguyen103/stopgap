import { assessImpact, NO_CATALOG_DATA, researchAlternatives } from "@stopgap/agents";
import { recordShadowRun, withOrgDb } from "@stopgap/db";
import { routeModel } from "@stopgap/providers";
import type { ReplayEntry } from "./corpus.js";
import { scoreAgreement } from "./score.js";

/**
 * Run one replay entry through the live agents and write the result to the shadow ledger.
 *
 * Shadow runs are strictly observational: they never touch a case, never send comms, and
 * never write a protocol. That isolation is the whole point — the ledger has to be able to
 * say "the agent would have done X" for inputs where letting it act would have been unsafe.
 *
 * `orgId` is an explicit parameter (PHASE6 §6.5) because the replay is an operator-run job with no
 * session: whoever runs `pnpm --filter @stopgap/shadow replay` chooses the tenant whose ledger the
 * results land in. The ledger is per-org for the same reason the KPI page is — promotion gates read
 * these aggregates, and one hospital must not promote an agent on another hospital's evidence.
 */
export async function runShadowEntry(
  orgId: string,
  entry: ReplayEntry,
  replayDay = new Date().toISOString().slice(0, 10),
): Promise<void> {
  // Validate the provider once, then pin both agent calls to it. A second independent health
  // check is allowed to fail, but it must fail the replay rather than silently charging a paid
  // provider to a ledger row whose cost is recorded as zero.
  const routed = await routeModel();
  if (routed.info.usdPer1mInput !== 0 || routed.info.usdPer1mOutput !== 0) {
    throw new Error(
      `shadow replay is local-provider only (routed to ${routed.info.name}/${routed.info.modelId}): ` +
        "per-call cost attribution for a paid provider is not implemented, and writing 0 into " +
        "the ledger's cost column would corrupt every per-class cost aggregate",
    );
  }
  const start = Date.now();
  const modelOptions = { provider: routed.info.name, allowFailover: false } as const;
  const impact = await assessImpact(entry.record, NO_CATALOG_DATA, modelOptions);
  const research = await researchAlternatives(entry.record, modelOptions);
  const latencyMs = Date.now() - start;

  const score = scoreAgreement(
    { severity: impact.severity, alternatives: research.alternatives },
    entry.baseline,
  );

  await withOrgDb(orgId, (db) =>
    recordShadowRun({
      orgId,
      corpusId: entry.id,
      replayDay,
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
      severityUnderCalled: score.severityUnderCalled,
      latencyMs,
      // 0 is the true cost of a free-provider run. A paid provider would need per-call token
      // counts plumbed back from the telemetry sink (they exist in the Langfuse span, not
      // here), so rather than write a fiction into a cost column the replay refuses above.
      usdCost: "0",
      provider: routed.info.name,
      modelId: routed.info.modelId,
    }, db),
  );
}
