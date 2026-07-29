import { draftDailyBrief } from "@stopgap/agents";
import { screenContent, describeViolations } from "@stopgap/compliance";
import {
  latestScoresForSignals,
  listOrganizations,
  listSignals,
  listCasesAwaitingHuman,
  previousDailyBrief,
  recordDailyBrief,
  withBypassDb,
  withOrgDb,
  type DegradedReason,
} from "@stopgap/db";

/**
 * The daily brief, generated on the durable workflow runtime (ticket 13).
 *
 * NO SECOND ORCHESTRATOR. This is an activity on the same Temporal spine every other scheduled job
 * runs on, and the model call goes through the existing provider registry — so failover, cost and
 * latency logging and tracing are inherited rather than reimplemented.
 *
 * Per tenant, by ENUMERATION, like the feed poll: the schedule has no session and no org, and it
 * does not invent one. `withBypassDb` lists the registry and nothing else.
 */

/** UTC date, so two tenants in different time zones still agree which day a brief covers. */
function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** How many signals the model is shown. The rest are counted, not listed. */
const BRIEF_SIGNAL_LIMIT = 100;

export async function generateDailyBriefs(now = new Date()): Promise<{
  generated: number;
  degraded: number;
}> {
  const orgs = await withBypassDb(() => listOrganizations());
  const briefDate = utcDate(now);
  let generated = 0;
  let degraded = 0;

  for (const org of orgs) {
    try {
      const { input, previousKeys, since } = await withOrgDb(org.id, async (db) => {
        const signals = await listSignals(db, org.id, {
          excludeFeedAbsent: true,
          limit: BRIEF_SIGNAL_LIMIT,
        });
        // THE NUMBER COMES FROM THE DETERMINISTIC SCORER, NOT FROM THE SIGNAL ROW (ADR-0002).
        // `riskSignals.severityScore` is the ingest heuristic each connector assigns on arrival;
        // ticket 07's scorer writes `risk_score_snapshots.score`, and that is the figure the rest
        // of the console shows. Two differently-derived numbers under one name is how a director
        // ends up escalating on a rank the product does not actually hold.
        const scores = await latestScoresForSignals(
          db,
          org.id,
          signals.map((s) => s.id),
        );
        const previous = await previousDailyBrief(db, org.id, briefDate);
        const awaiting = await listCasesAwaitingHuman(db, org.id);
        // Highest risk first, because that is what the model is told it is being given. An
        // unscored signal sorts last rather than as a zero: "not scored yet" and "scored zero"
        // are different facts, and only one of them means the signal is unimportant.
        const ranked = signals
          .map((s) => ({ signal: s, score: scores.get(s.id)?.score }))
          .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
        return {
          previousKeys: previous?.signalKeys ?? [],
          since: previous?.briefDate,
          input: {
            current: ranked.map(({ signal, score }) => ({
              entity: signal.entityIdentifier,
              domain: signal.riskDomain,
              severity: signal.severity,
              score,
              title: signal.title,
              key: signal.dedupeKey,
            })),
            awaitingReview: awaiting,
          },
        };
      });

      let draft;
      let model: string | null = null;
      let degradedReason: DegradedReason | null = null;
      try {
        const drafted = await draftDailyBrief({ ...input, previousKeys, since });
        draft = drafted.brief;
        model = drafted.model;
      } catch (err) {
        // A provider outage DEGRADES the brief rather than failing it: the row still lands, saying
        // what could not be done. A director who sees nothing cannot tell "nothing happened" from
        // "we could not write it", and those need different responses.
        degradedReason = "provider_unavailable";
        draft = {
          headline: "Brief unavailable — no model provider could be reached.",
          changes: [],
          newlyAtRisk: [],
          needsReview: [],
        };
        console.error(
          `[brief] provider unavailable for org ${org.id}: ` +
            `${err instanceof Error ? err.message : String(err)}. Recording a degraded brief.`,
        );
      }

      // THE GUARD RUNS BEFORE THE TEXT IS STORED, not before it is displayed. Storing first and
      // screening later means the unscreened text has already been written somewhere a query can
      // reach, and "we screen it on the way out" is a promise every future reader has to keep.
      if (!degradedReason) {
        const report = screenContent(
          [draft.headline, ...draft.changes, ...draft.newlyAtRisk, ...draft.needsReview].join("\n"),
        );
        if (!report.ok) {
          degradedReason = "compliance_blocked";
          console.error(
            `[brief] compliance guard refused the brief for org ${org.id}: ` +
              `${describeViolations(report)}. Recording a blocked brief.`,
          );
          draft = {
            headline: "Brief withheld — the generated text did not pass the compliance guard.",
            changes: [],
            newlyAtRisk: [],
            needsReview: [],
          };
        }
      }

      await withOrgDb(org.id, (db) =>
        recordDailyBrief(db, org.id, {
          briefDate,
          headline: draft.headline,
          changes: draft.changes,
          newlyAtRisk: draft.newlyAtRisk,
          needsReview: draft.needsReview,
          signalKeys: input.current.map((s) => s.key),
          degradedReason,
          model,
          generatedAt: now,
        }),
      );
      if (degradedReason) degraded += 1;
      else generated += 1;
    } catch (err) {
      // ONE TENANT'S BRIEF STOPS THAT TENANT, NOT THE SCHEDULE — the containment the feed poll
      // already applies per organization.
      console.error(
        `[brief] generation failed for org ${org.id}: ` +
          `${err instanceof Error ? err.message : String(err)}. Other tenants continue.`,
      );
    }
  }

  return { generated, degraded };
}
