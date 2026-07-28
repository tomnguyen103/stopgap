import { Context } from "@temporalio/activity";
import { getEnv } from "@stopgap/core/env";
import type { CaseStatus, Severity } from "@stopgap/core";
import {
  anchorAuditChain as runAuditAnchor,
  appendAudit,
  approveProtocolVersion,
  assertMaintenanceRoleBypassesRls,
  bumpFeedMiss,
  bumpSignalFeedMiss,
  draftProtocolVersion,
  getApprovedProtocol,
  getCaseByKey,
  getCasesByKeys,
  getDb,
  getEscalationPolicy as readEscalationPolicy,
  getSyntheticUser,
  isUserInOrg,
  listOrganizations,
  recordAcknowledgment,
  syntheticUserIdForLabel,
  listOpenMonitoringCases,
  matchSignalToCatalog,
  matchSignalsToCatalog,
  exposureFacts,
  summarizeExposure,
  type ExposureFacts,
  type Db,
  catalogExposure,
  listRoleRecipients,
  recordFeedRecords,
  lastFiredByRule,
  listAlertRules,
  recordAlertDeliveries,
  recordAlertEvents,
  recordEvidence,
  recordScoreSnapshots,
  type EvidenceInput,
  dedupeByKey,
  type ScoreSnapshotInput,
  resetFeedMiss,
  sweepOrgRetention,
  totalRemoved,
  RETAINED_FOREVER,
  type RetentionWindows,
  type RetentionSweepResult,
  upsertSignals,
  updateCaseStatus,
  upsertCaseForRecord,
  withBypassDb,
  workflowIdForKey,
  withOrgDb,
  type EscalationStep,
} from "@stopgap/db";
import { sendChat, sendEhrFlag, sendEmail } from "@stopgap/comms";
import { incrementCounter } from "@stopgap/observability";
import type { SignalMatch } from "@stopgap/catalog";
import { componentsToRecord, scoreSignals, type ScorableSignal } from "@stopgap/scorer";
import {
  evaluateAlerts,
  suppressionKey,
  summarize,
  type AlertChannel,
  type AlertRule,
  type AlertableSignal,
} from "@stopgap/alerts";
import {
  ashpShortageConnector,
  contentHash,
  mapAshpShortage,
  mapOpenFdaResult,
  mergeRecords,
  openFdaDeviceRecallConnector,
  openFdaDrugRecallConnector,
  openFdaShortageConnector,
  type AshpEntry,
  type NormalizedSignal,
  type OpenFdaResult,
  matchHintsForRecord,
} from "@stopgap/ingest";
import * as agents from "@stopgap/agents";
import { makeClient, markResolved, startCase } from "./client.js";
import { diffResolutions } from "./feed-resolution.js";
import type {
  CaseInput,
  ImpactResult,
  ProtocolMemoryHit,
  RecordProtocolInput,
  ResearchResult,
  ReviewDecision,
} from "./shared.js";

/**
 * TENANT SCOPING IN THE WORKER (PHASE6 §6.5).
 *
 * A worker has no session and no HTTP request, so there is nothing ambient to derive an org from.
 * Every case activity therefore takes `orgId` as an ARGUMENT, threaded from the workflow input
 * (`CaseInput.orgId`) that was fixed when the case was opened. The two consequences worth naming:
 *
 *  - the org cannot drift over a case's multi-week life — a redeploy cannot make week 6's audit
 *    entry land in a different hospital's chain from week 1's;
 *  - every DB call runs inside `withOrgDb(orgId, ...)`, so `app.current_org` is set for the
 *    transaction and the RLS policies are actually exercised in production rather than merely
 *    installed. A bug that lost the org here produces an empty result, not another tenant's data.
 *
 * The two activities that are genuinely deployment-wide — the feed poll (one external feed, N
 * tenants) and audit anchoring — say so at their own definitions and use `withBypassDb` only to
 * ENUMERATE organizations, never to touch tenant rows.
 */

/**
 * Activities are the only place workflows touch the outside world (DB, feeds, LLMs). The
 * judgment activities (`assessImpact`, `researchAlternatives`) call the Zod-validated AI SDK
 * agents in `@stopgap/agents` (PROJECT_PLAN §8: "schema-validated outputs everywhere",
 * temperature 0 for eval reproducibility). The DB-side effects are real. Every activity is
 * idempotent so Temporal retries are safe.
 */

/**
 * The workflow run an activity is executing for. Audit entries are idempotent per run, so a
 * recurring shortage (a new run against the same case row) appends its own trail instead of
 * colliding with the previous run's.
 */
function currentRunId(): string | undefined {
  return Context.current().info.workflowExecution?.runId;
}

/** Persist a newly detected case and open the audit chain. Idempotent (upsert). */
export async function recordDetected(input: CaseInput): Promise<void> {
  await withOrgDb(input.orgId, async (db) => {
    const row = await upsertCaseForRecord(db, input.orgId, input.record);
    await appendAudit(db, {
      orgId: input.orgId,
      caseId: row.id,
      actor: "system",
      actorUserId: getSyntheticUser("system"),
      action: "case.detected",
      detail: { key: input.record.key, sources: input.sources },
      runId: currentRunId(),
    });
  });
}

/** Mirror the workflow's status transition to Postgres + audit log. */
export async function persistStatus(
  orgId: string,
  key: string,
  status: CaseStatus,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await withOrgDb(orgId, async (db) => {
    // BY KEY, not by a recomputed workflow id (PHASE6 §6.5). `workflowIdForKey` now returns the
    // org-qualified format, but a case opened before that change still stores `case-<key>`; looking
    // it up by id would miss every such row, and the status update would silently write nothing
    // while the audit entry lost its `caseId`. The `(org_id, key)` index answers the question
    // regardless of which era the row was written in, and the row carries the id Temporal knows.
    const row = await getCaseByKey(db, orgId, key);
    if (row) {
      await updateCaseStatus(db, orgId, row.workflowId, status, {
        severity: detail.severity as Severity | undefined,
        lastNote: detail.note as string | undefined,
        closedAt: status === "closed" ? new Date() : undefined,
      });
    }
    const statusActor = (detail.actor as string) ?? "system";
    await appendAudit(db, {
      orgId,
      caseId: row?.id,
      actor: statusActor,
      actorUserId:
        (detail.actorUserId as string | undefined) ?? syntheticUserIdForLabel(statusActor),
      action: `case.${status}`,
      detail,
      runId: currentRunId(),
      // The monitoring loop persists `case.monitoring` every completed week, so the week
      // number has to be part of the idempotency key — otherwise week 2 onwards look like
      // retries of week 1 and never reach the audit trail.
      eventKey:
        detail.monitoringWeeks === undefined
          ? `case.${status}`
          : `case.${status}.week-${String(detail.monitoringWeeks)}`,
    });
  });
}

/** Impact assessment via the Zod-validated AI SDK agent (Gemini/Ollama, health-routed). */
export async function assessImpact(input: CaseInput): Promise<ImpactResult> {
  try {
    // Ticket 16 — the assessment reads THIS facility's catalog rather than a simulated formulary.
    // Scoped to the case's own org, like every other read on this path: a shortage means something
    // different to a hospital that stocks four presentations of the drug than to one that stocks
    // none, and that difference is exactly what the model was previously left to guess at.
    const catalog = await withOrgDb(input.orgId, async (db) => {
      const matches = await matchSignalToCatalog(
        db,
        input.orgId,
        matchHintsForRecord(input.record),
      );
      const exposure = await catalogExposure(
        db,
        input.orgId,
        matches.map((m) => m.itemId),
        new Date(),
      );
      return {
        matchedItems: matches.length,
        daysOnHand: exposure.daysOnHand,
        supplierSiteCount: exposure.supplierSiteCount,
        soleSourcedItems: exposure.soleSourcedItemIds.length,
      };
    });
    const assessment = await agents.assessImpact(input.record, catalog);
    return { ...assessment, affectedFormularyItems: catalog.matchedItems };
  } catch (err) {
    // Count the throw before it propagates to Temporal's retry (PHASE6 §6.4 task-failure metric).
    // A provider outage is the common cause and is exactly what the ops dashboard should surface.
    incrementCounter("stopgap_workflow_task_failures_total", { activity: "assessImpact" });
    throw err;
  }
}

/** Alternatives research via the Zod-validated AI SDK agent (Gemini/Ollama, health-routed). */
export async function researchAlternatives(input: CaseInput): Promise<ResearchResult> {
  try {
    return await agents.researchAlternatives(input.record);
  } catch (err) {
    incrementCounter("stopgap_workflow_task_failures_total", { activity: "researchAlternatives" });
    throw err;
  }
}

/**
 * Outbound comms: email the approved protocol to the pharmacy list and flag the substitution
 * in the EHR (PROJECT_PLAN §5). Both channels are keyed on the case + run so an activity
 * retry cannot page the pharmacy twice, and a non-delivery (no credentials, unreachable
 * endpoint) is recorded in the audit trail rather than swallowed — "we told the floor" has to
 * be falsifiable.
 */
export async function sendComms(
  orgId: string,
  key: string,
  draft: string,
  alternatives: string[] = [],
): Promise<{ delivered: boolean }> {
  const row = await withOrgDb(orgId, (db) => getCaseByKey(db, orgId, key));
  // The case row's own workflow id, so a pre-migration case keeps the idempotency key it has
  // always had and a retry after this deploy is still recognised as a retry.
  const workflowId = row?.workflowId ?? workflowIdForKey(orgId, key);
  const idempotencyKey = `${workflowId}:${currentRunId() ?? "no-run"}:comms`;
  const results = await Promise.all([
    sendEmail({
      idempotencyKey: `${idempotencyKey}:email`,
      subject: `Drug shortage protocol: ${key}`,
      body: draft,
      to: [],
    }),
    sendEhrFlag({ idempotencyKey: `${idempotencyKey}:ehr`, key, alternatives, body: draft }),
  ]);
  await withOrgDb(orgId, (db) =>
    appendAudit(db, {
      orgId,
      caseId: row?.id,
      actor: "system",
      actorUserId: getSyntheticUser("system"),
      action: "comms.sent",
      detail: { chars: draft.length, channels: results },
      runId: currentRunId(),
    }),
  );
  // Per-channel delivery/non-delivery counters for the ops dashboard (PHASE6 §6.4). Honest either
  // way: a non-delivery (no credentials, unreachable endpoint) increments the non-delivered series.
  for (const result of results) {
    incrementCounter(
      result.delivered ? "stopgap_comms_delivered_total" : "stopgap_comms_nondelivered_total",
      { channel: result.channel },
    );
  }
  // Reported back so the case records whether anything actually went out — the `comms_sent`
  // state means "we tried", and a case that claims delivery no transport performed would be
  // exactly the kind of unfalsifiable assertion this system is supposed to avoid.
  return { delivered: results.some((result) => result.delivered) };
}

/**
 * Record a HITL decision in the audit chain (provenance for the review).
 *
 * THE REVIEWER'S `users.id` IS VALIDATED AGAINST THE ORG BEFORE IT IS WRITTEN (PHASE6 §6.5), and
 * that is a stated decision rather than an oversight either way.
 *
 * `actorUserId` arrives on the workflow SIGNAL payload, so it is whatever the signaller sent. The
 * foreign key to `users` does not constrain it to this tenant, and — the part that is easy to miss
 * — PostgreSQL performs referential-integrity checks with row security DISABLED, so the FK happily
 * resolves a `users.id` belonging to another organization even on a fully scoped connection. Left
 * unchecked, an audit row in org A can name a clinician in org B. Under `v4` that pair is hashed,
 * which makes the claim tamper-EVIDENT (it cannot be altered later) but not tamper-PROOF (it can be
 * written wrong in the first place), and a tamper-evident record of a false statement is still a
 * false statement.
 *
 * The choice made here is to REFUSE the id and keep the event, not to reject the whole signal. The
 * decision itself is real clinical work that already happened in the workflow; dropping the audit
 * row to punish a bad identity claim would lose the more important half. So a foreign or unknown id
 * is recorded as `identitySource: "rejected-foreign-user-id"` with `actorUserId` left NULL and the
 * rejected value preserved in the detail — the chain then says "someone claimed to be this user and
 * we could not corroborate it", which is the honest content of the situation.
 */
export async function recordDecision(
  orgId: string,
  key: string,
  decision: ReviewDecision,
): Promise<void> {
  await withOrgDb(orgId, async (db) => {
    const row = await getCaseByKey(db, orgId, key);
    // Resolved on the ORG-SCOPED handle, so RLS is doing the work and the predicate is only the
    // visible-and-explicit half of it: a user in another tenant is not merely filtered out here,
    // it is invisible to this connection.
    const claimedUserId = decision.reviewerUserId;
    const reviewerInOrg =
      claimedUserId !== undefined && (await isUserInOrg(db, orgId, claimedUserId))
        ? claimedUserId
        : undefined;
    await appendAudit(db, {
      orgId,
      caseId: row?.id,
      // The `actor` text stays the claimed label (kept stable — it is what the chain hashes).
      // `actorUserId` is the machine-checkable principal, and it is now only written when it
      // actually checks out; a CLI/MCP signal without one leaves it NULL, honestly, as before.
      actor: decision.reviewer ?? "unknown-reviewer",
      actorUserId: reviewerInOrg,
      action: `review.${decision.kind}`,
      detail: {
        ...decision,
        identitySource:
          claimedUserId === undefined
            ? "workflow-signal-claim"
            : reviewerInOrg
              ? "authenticated-session"
              : "rejected-foreign-user-id",
      },
      runId: currentRunId(),
    });
  });
}

/**
 * Poll openFDA + ASHP, merge duplicates across feeds, and open a durable case PER ORGANIZATION for
 * every current shortage not already tracked (PROJECT_PLAN §4: "poll → new shortage auto-opens a
 * case"). Idempotent: `startCase`'s conflict policy makes an already-open case a no-op here. Runs
 * on a Temporal Schedule (see `scripts/start-schedule.ts`), so this activity itself opens a client
 * connection per invocation rather than holding one across the worker.
 *
 * THE ONE ACTIVITY WITH NO SESSION AND NO CASE (PHASE6 §6.5). Every other activity is handed an
 * org by the workflow that started it; the schedule is handed nothing. The org therefore comes from
 * ENUMERATION: `listOrganizations()` through `withBypassDb`, then a full pass of the poll's work
 * inside `withOrgDb(org.id, ...)` for each one.
 *
 * That shape follows from what the feed IS. One openFDA snapshot is a single physical fact about
 * the drug supply — identical for every hospital, which is exactly why `feed_records` is a GLOBAL
 * table and why the HTTP fetch happens ONCE, outside the loop, rather than N times. What is
 * per-tenant is the CONSEQUENCE of that fact: each hospital gets its own case for the shortage,
 * because a case is that hospital's clinical work, its own protocol history, and its own audit
 * chain. Fetching once and acting N times is the only division that keeps both halves honest.
 *
 * `withBypassDb` is used ONLY to list organizations and to write the global `feed_records` — never
 * to read or write a tenant row. The registry is the one table that cannot be org-scoped (a session
 * must resolve its own org before `app.current_org` can be set), and this is precisely the
 * deployment-wide job it exists for.
 */
/**
 * One adopted feed, with its raw type erased.
 *
 * A registry rather than four named constants threaded through four places: adding a fifth feed
 * was otherwise an edit to the fetch block, the raw-payload type, the normalizer and the
 * polled-source list — four chances to add a feed that fetches but never persists. Methods rather
 * than function properties, so a `Connector<OpenFdaResult>` satisfies it without a cast.
 */
interface PollableFeed {
  readonly source: string;
  fetch(): Promise<unknown[]>;
  normalize(raw: never, context: { orgId: string; fetchedAt: string }): NormalizedSignal;
}

/**
 * Every feed the poll reads, and whether its failure may stop the poll.
 *
 * The shortage feeds are `required`: a poll that silently opened no cases would be worse than a
 * failed one, and that is the behaviour this activity has always had. Recalls are additive to a
 * poll that already worked, so a recall endpoint being down must not stop this deployment
 * noticing shortages.
 */
const POLLED_FEEDS: { feed: PollableFeed; required: boolean }[] = [
  { feed: openFdaShortageConnector, required: true },
  { feed: ashpShortageConnector, required: true },
  { feed: openFdaDrugRecallConnector, required: false },
  { feed: openFdaDeviceRecallConnector, required: false },
];

interface FeedResult {
  source: string;
  rows: unknown[];
  normalize: PollableFeed["normalize"];
  /**
   * Whether this poll can tell this feed apart from a broken one.
   *
   * TRUE only when the fetch resolved AND returned at least one row. A feed that returned nothing
   * is indistinguishable IN THE DATA from a feed that failed quietly — ASHP answers `[]` with no
   * auth key, and openFDA answers 404 for an empty result set exactly as it does for a bad path —
   * so its existing signals are left out of the miss sweep. The cost is that a genuinely emptied
   * feed never retires its signals by absence; the alternative is retiring live recalls because a
   * key expired, and between those two the conservative reading is the one that keeps the case
   * open.
   */
  attested: boolean;
}

/** Fetch every feed once for the deployment. Required feeds still throw; additive ones do not. */
async function fetchFeeds(): Promise<FeedResult[]> {
  return Promise.all(
    POLLED_FEEDS.map(async ({ feed, required }) => {
      try {
        const rows = await feed.fetch();
        return { source: feed.source, rows, normalize: feed.normalize, attested: rows.length > 0 };
      } catch (err) {
        if (required) throw err;
        incrementCounter("stopgap_feed_fetch_failures_total");
        console.error(
          `[poll] ${feed.source} fetch failed: ${err instanceof Error ? err.message : String(err)}. ` +
            "The poll continues without that feed. Its existing signals are left alone - they are " +
            "NOT counted as missing, because an outage is not the feed saying the hazard ended.",
        );
        return { source: feed.source, rows: [], normalize: feed.normalize, attested: false };
      }
    }),
  );
}

/**
 * Turn one deployment-wide fetch into ONE tenant's signals.
 *
 * Pure: no network, no database, no clock — the fetch time comes from the caller, so every org in
 * one poll shares a `lastFetchedAt` and the whole poll stays reproducible.
 */
function normalizeForOrg(
  feeds: FeedResult[],
  context: { orgId: string; fetchedAt: string },
): NormalizedSignal[] {
  return feeds.flatMap((f) => f.rows.map((row) => f.normalize(row as never, context)));
}

/**
 * Score each signal this poll wrote, one snapshot apiece.
 *
 * PER SIGNAL rather than per facility: each signal is matched against THIS tenant's catalog
 * (ticket 16), and the exposure that match unlocks — days on hand, supplier sites — is what
 * switches on the two components that were dark while the catalog slice was outstanding.
 *
 * A signal that matches NOTHING still scores. Its catalog components stay UNAVAILABLE rather than
 * becoming zero, because "this facility does not stock the affected product" and "we have no
 * catalog data" are different facts and only one of them means there is no exposure. The scorer
 * reports the total against `reachableMax`, so a partially-scored signal is still comparable.
 */
async function scoreForPoll(
  db: Db,
  orgId: string,
  signals: NormalizedSignal[],
  persisted: { id: string; dedupeKey: string }[],
  evaluatedAt: string,
) {
  const idByKey = new Map(persisted.map((row) => [row.dedupeKey, row.id]));

  // ONE match pass and ONE fact fetch for the whole batch, not one per signal. A poll writes tens
  // of signals per tenant inside a single transaction, and a per-signal round trip would hold that
  // transaction — and its pooled connection — open across an N+1 for work that is one query either
  // way.
  //
  // A CATALOG FAILURE DEGRADES THE SCORE, IT DOES NOT LOSE THE SIGNAL. This runs inside the same
  // transaction as `upsertSignals`, so letting the error escape would roll back signals that were
  // written perfectly well. Scoring falls back to the no-catalog reading — components unavailable,
  // exactly as before the catalog landed — and says so.
  let matchesBySignal = new Map<string, SignalMatch[]>();
  let facts: ExposureFacts = { stock: [], burn: [], links: [] };
  try {
    const matched = await matchSignalsToCatalog(
      db,
      orgId,
      signals.map((s) => s.matchHints),
    );
    matchesBySignal = new Map(signals.map((s, i) => [s.dedupeKey, matched[i] ?? []]));
    facts = await exposureFacts(
      db,
      orgId,
      [...new Set(matched.flat().map((m) => m.itemId))],
      new Date(evaluatedAt),
    );
  } catch (err) {
    incrementCounter("stopgap_catalog_match_failures_total");
    console.error(
      `[poll] catalog matching failed for org ${orgId}: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        "Signals are still written and scored; their catalog components stay unavailable.",
    );
  }

  const snapshots: ScoreSnapshotInput[] = [];
  // Collapsed on the dedupe key first, exactly as `upsertSignals` collapses its own batch. Two feed
  // records deriving the same key resolve to ONE persisted row, so scoring both would emit two
  // snapshots sharing (org, signal, scorer version, moment) — and `ON CONFLICT DO UPDATE` refuses
  // to touch a row twice in one statement, aborting the whole tenant's write, signals included.
  for (const signal of dedupeByKey(signals)) {
    const signalId = idByKey.get(signal.dedupeKey);
    // A signal with no persisted row is one the upsert did not return; scoring it would attach a
    // snapshot to nothing. Skipped rather than guessed.
    if (!signalId) continue;
    const scorable: ScorableSignal = {
      dedupeKey: signal.dedupeKey,
      source: signal.source,
      riskDomain: signal.riskDomain,
      severity: signal.severity,
      severityScore: signal.severityScore,
      confidence: signal.confidence,
      publishedAt: signal.publishedAt,
      sourceResolved: signal.sourceResolved,
    };
    const exposure = summarizeExposure(
      facts,
      (matchesBySignal.get(signal.dedupeKey) ?? []).map((m) => m.itemId),
    );
    const result = scoreSignals({
      signals: [scorable],
      catalog: {
        daysOnHand: exposure.daysOnHand,
        supplierSiteCount: exposure.supplierSiteCount,
        soleSourcedItemIds: exposure.soleSourcedItemIds,
      },
      evaluatedAt,
    });
    snapshots.push({
      signalId,
      score: result.score,
      band: result.band,
      components: componentsToRecord(result),
      reachableMax: result.reachableMax,
      scorerVersion: result.scorerVersion,
      computedAt: new Date(evaluatedAt),
    });
  }
  return snapshots;
}

/**
 * One evidence artifact per signal this poll wrote.
 *
 * `contentHash` is the same `contentHash` the poller already uses for feed records, so "has this
 * record changed since we captured it" is answered by comparing two fingerprints rather than by
 * keeping two copies of the text.
 */
function evidenceForPoll(
  signals: NormalizedSignal[],
  persisted: { id: string; dedupeKey: string }[],
  capturedAt: string,
): EvidenceInput[] {
  const idByKey = new Map(persisted.map((row) => [row.dedupeKey, row.id]));
  const entries: EvidenceInput[] = [];
  for (const signal of signals) {
    const signalId = idByKey.get(signal.dedupeKey);
    if (!signalId) continue;
    entries.push({
      signalId,
      type: "provider_record" as const,
      source: signal.source,
      sourceId: signal.sourceId,
      originUrl: signal.evidenceUrl,
      contentHash: contentHash(signal.raw),
      capturedAt: new Date(capturedAt),
    });
  }
  return entries;
}

/**
 * Pair each signal with the row it was persisted as and the score it was given.
 *
 * By dedupe KEY, never by array index: `scoreForPoll` skips a signal that has no persisted row, so
 * the two lists are not parallel and an index join would silently attach one drug's score to
 * another drug's signal.
 */
function pairScored(
  signals: NormalizedSignal[],
  persisted: { id: string; dedupeKey: string }[],
  snapshots: ScoreSnapshotInput[],
): { signal: NormalizedSignal; signalId: string; score: number }[] {
  const idByKey = new Map(persisted.map((row) => [row.dedupeKey, row.id]));
  const scoreById = new Map(snapshots.map((s) => [s.signalId, s.score]));
  const out: { signal: NormalizedSignal; signalId: string; score: number }[] = [];
  for (const signal of signals) {
    const signalId = idByKey.get(signal.dedupeKey);
    if (!signalId) continue;
    const score = scoreById.get(signalId);
    if (score === undefined) continue;
    out.push({ signal, signalId, score });
  }
  return out;
}

/**
 * Evaluate this tenant's alert rules against what the poll just scored, and notify (ticket 12).
 *
 * Runs INSIDE the org's own transaction for the decision and the record, and OUTSIDE it for the
 * sends — the same division the case loop already makes. Holding a database transaction open
 * across an email round trip pins a pooled connection for the duration of somebody else's network,
 * which is how a poll starves a deployment.
 *
 * The send is guarded by the ROW, not by the caller remembering: `recordAlertEvents` returns only
 * the events that were genuinely new, so a retried poll conflicts on the idempotency key, gets an
 * empty list, and sends nothing.
 */
async function evaluateAndNotify(
  orgId: string,
  scored: { signal: NormalizedSignal; signalId: string; score: number }[],
  evaluatedAt: string,
): Promise<void> {
  const alertable: AlertableSignal[] = scored.map((s) => ({
    signalId: s.signalId,
    dedupeKey: s.signal.dedupeKey,
    riskDomain: s.signal.riskDomain,
    entityIdentifier: s.signal.entityIdentifier,
    severity: s.signal.severity,
    score: s.score,
    title: s.signal.title,
  }));

  const { evaluation, newEvents, webhookByRule, recipients } = await withOrgDb(
    orgId,
    async (db) => {
      const rows = await listAlertRules(db, orgId);
      const rules: AlertRule[] = rows.map((r) => ({
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        riskDomain: r.riskDomain ?? undefined,
        entityContains: r.entityContains ?? undefined,
        minSeverity: r.minSeverity as AlertRule["minSeverity"],
        cooldownMinutes: r.cooldownMinutes,
        channels: r.channels as AlertChannel[],
      }));
      // This tenant's own webhooks, kept beside the rules rather than in the environment: a
      // deployment-wide chat URL would put every organization's drug names in one room.
      const webhookByRule = new Map(rows.map((r) => [r.id, r.chatWebhookUrl ?? undefined]));
      if (rules.length === 0) {
        return {
          evaluation: { fired: [], suppressed: [] },
          newEvents: [],
          webhookByRule: new Map<string, string | undefined>(),
          recipients: [] as string[],
        };
      }

      const lastFiredAt = await lastFiredByRule(
        db,
        orgId,
        rules.map((r) => r.id),
      );
      const result = evaluateAlerts({ rules, signals: alertable, lastFiredAt, evaluatedAt });

      // Suppressed evaluations are recorded too. "This rule matched twelve signals and stayed quiet
      // until 14:20" is exactly what a director tuning a rule needs to read, and a table holding
      // only successes answers "what did we send" but never "what did we decide".
      const rows2 = await recordAlertEvents(db, orgId, [
        ...result.fired.map((f) => ({
          ruleId: f.rule.id,
          outcome: "fired" as const,
          matchedCount: f.matched.length,
          matchedKeys: f.matched.map((m) => m.dedupeKey),
          deliveries: [],
          idempotencyKey: f.idempotencyKey,
          firedAt: new Date(evaluatedAt),
        })),
        ...result.suppressed.map((sp) => ({
          ruleId: sp.rule.id,
          outcome: "suppressed_cooldown" as const,
          matchedCount: sp.matched.length,
          matchedKeys: sp.matched.map((m) => m.dedupeKey),
          deliveries: [],
          idempotencyKey: suppressionKey(sp.rule, evaluatedAt),
          firedAt: new Date(evaluatedAt),
        })),
      ]);
      // The tenant's OWN recipients, resolved through the ladder's existing helper. This module
      // does not decide who is told — it asks the thing that owns that question.
      const recipients = await listRoleRecipients(db, orgId, "pharmacist");
      return { evaluation: result, newEvents: rows2, webhookByRule, recipients };
    },
  );

  for (const fired of evaluation.fired) {
    const event = newEvents.find((e) => e.idempotencyKey === fired.idempotencyKey);
    // ALREADY DELIVERED is the stop condition, not "the row already existed". A poll that recorded
    // a firing and then died before sending must be able to try again; stopping on the row's mere
    // existence would leave that firing permanently silent while its cooldown ran.
    if (!event || event.outcome !== "fired" || event.deliveredAny) continue;

    const { subject, body } = summarize(fired);
    const deliveries: { channel: string; delivered: boolean; reason?: string }[] = [];
    for (const channel of fired.rule.channels) {
      // A channel with no credential returns `delivered: false` WITH A REASON, and that is what
      // gets recorded. Never a faked success — "the pharmacy was told" has to stay falsifiable.
      const result =
        channel === "chat"
          ? await sendChat({
              idempotencyKey: fired.idempotencyKey,
              subject,
              body,
              webhookUrl: webhookByRule.get(fired.rule.id),
            })
          : await sendEmail({
              idempotencyKey: fired.idempotencyKey,
              subject,
              body,
              to: recipients,
            });
      deliveries.push({
        channel: result.channel,
        delivered: result.delivered,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    await withOrgDb(orgId, (db) => recordAlertDeliveries(db, orgId, event.id, deliveries));
  }
}
export async function pollAndOpenCases(): Promise<{
  polled: number;
  opened: number;
  resolved: number;
}> {
  // ONE fetch per feed for the whole deployment, then N normalizations — the same division the
  // rest of this activity already makes. The raw payloads serve BOTH consumers: the legacy
  // `ShortageRecord` path that opens cases, and the normalized-signal path (ticket 06) that
  // persists per tenant. Fetching twice for the two shapes would double every provider call to
  // store the same bytes.
  const feeds = await fetchFeeds();
  const rowsOf = (source: string) => feeds.find((f) => f.source === source)?.rows ?? [];
  const openFdaRaw = rowsOf(openFdaShortageConnector.source) as OpenFdaResult[];
  const ashpRaw = rowsOf(ashpShortageConnector.source) as AshpEntry[];
  // Only the feeds this poll can vouch for. See `FeedResult.attested`.
  const attestedSources = feeds.filter((f) => f.attested).map((f) => f.source);
  const fetched = [
    ...openFdaRaw.map(mapOpenFdaResult),
    ...ashpRaw.map((entry) => mapAshpShortage(entry.key, entry.shortage)),
  ];
  // Persist what the feeds returned before deciding what to do with it: `feed_records` is the
  // provenance trail behind every case, and the only thing that can answer "when did this
  // deployment last hear from openFDA" (the console's freshness panel). Resolved records are
  // stored too — a shortage dropping off the feed is information. Written ONCE for the whole
  // deployment: per-org copies would multiply this write by the tenant count to store N
  // byte-identical rows and would break the `(source, source_id)` dedup contract.
  await withBypassDb((db) => recordFeedRecords(db, fetched, contentHash));
  // One merge for both jobs: opening cases for `current` shortages, and — the §6.6 half —
  // resolving monitoring cases whose key the feed now lists `resolved` or no longer lists.
  const merged = mergeRecords(fetched);
  const current = merged.filter((r) => r.status === "current");
  const currentKeys = new Set(current.map((r) => r.key));
  const resolvedKeys = new Set(merged.filter((r) => r.status === "resolved").map((r) => r.key));

  const orgs = await withBypassDb(() => listOrganizations());
  const pollTimestamp = new Date().toISOString();
  // The run token behind the retry-idempotent miss counter. `currentRunId()` differs per
  // poll execution (so distinct polls increment) and is stable across retries of the same
  // execution (so a retry is a no-op); the ISO-timestamp fallback keeps it deterministic if
  // ever called outside a Temporal activity context.
  const pollRun = currentRunId() ?? pollTimestamp;

  const { client, connection } = await makeClient();
  try {
    let opened = 0;
    let resolved = 0;
    const currentKeyList = current.map((r) => r.key);
    for (const org of orgs) {
      // ONE database scope per organization, not one per (organization, shortage) (PHASE6 §6.5).
      // The previous shape opened a `withOrgDb` — a transaction, and a checkout from a `max: 10`
      // pool — for every single record, so a hundred shortages across fifty tenants was five
      // thousand transactions in one poll. Both reads this org needs are taken up front, in one
      // scope: the existing cases for the keys in this snapshot, and the open monitoring cases.
      //
      // The Temporal calls stay OUTSIDE that scope on purpose. Holding a database transaction open
      // across a `startCase` RPC would pin a pooled connection for the duration of a network round
      // trip per record, which is the same starvation problem in a different shape — a transaction
      // is for the database work, not for the whole iteration.
      // Ticket 06 — this tenant's INTERPRETATION of what the feeds returned. Normalized per org
      // (the dedupe key is org-scoped), written inside this org's own transaction, and never
      // shared: two hospitals reading the same recall hold genuinely different signals.
      let scoredForAlerts: { signal: NormalizedSignal; signalId: string; score: number }[] = [];
      const signals = normalizeForOrg(feeds, { orgId: org.id, fetchedAt: pollTimestamp });
      // ONE TENANT'S SIGNAL WRITE MUST NOT STOP THE POLL — the containment the resolution loop
      // below already applies per case, and the reason `fetchFeeds` contains an additive feed's
      // failure. Unguarded, one org's write error means every LATER org gets no case opened this
      // cycle, which reads in the runbook as "the poller stopped".
      try {
        await withOrgDb(org.id, async (db) => {
          const persisted = await upsertSignals(db, org.id, signals);
          // The FEED-ABSENT half, kept distinct from `sourceResolved`: a signal the poll did not
          // return has said nothing about whether the hazard is over.
          await bumpSignalFeedMiss(
            db,
            org.id,
            signals.map((s) => s.dedupeKey),
            pollRun,
            attestedSources,
          );
          // Ticket 07 — scoring happens HERE, on the durable poll workflow, and nowhere else. No
          // second orchestrator: the score is a consequence of the signals this poll just wrote,
          // in the same transaction, so a snapshot can never describe a signal row that failed to
          // land. `pollTimestamp` is the evaluation time for EVERY org in this poll, which is what
          // makes two tenants' scores comparable and the whole poll reproducible.
          const snapshots = await scoreForPoll(db, org.id, signals, persisted, pollTimestamp);
          await recordScoreSnapshots(db, org.id, snapshots);
          // Ticket 09 — the durable trail behind each signal. A pointer and a fingerprint, never
          // the payload: see the table's own doc block for why a long-retention table stays free
          // of content.
          await recordEvidence(db, org.id, evidenceForPoll(signals, persisted, pollTimestamp));
          // Ticket 12 — what the alert rules are evaluated against, paired by dedupe key inside
          // this transaction and notified outside it.
          scoredForAlerts = pairScored(signals, persisted, snapshots);
        });
        // Ticket 12 — decide what is worth telling someone about, and tell them. Outside the write
        // transaction above on purpose: the sends are network calls, and a transaction held across
        // one pins a pooled connection for the duration of somebody else's SMTP.
        await evaluateAndNotify(org.id, scoredForAlerts, pollTimestamp);
      } catch (err) {
        incrementCounter("stopgap_signal_persist_failures_total");
        console.error(
          `[poll] signal persistence failed for org ${org.id}: ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            "That tenant keeps its previous signals and its miss counters are unchanged, so the " +
            "next poll retries it; case opening for this org and every later one continues.",
        );
      }

      const { existingWorkflowIds, openCases } = await withOrgDb(org.id, async (db) => {
        const rows = await getCasesByKeys(db, org.id, currentKeyList);
        return {
          existingWorkflowIds: new Map(rows.map((r) => [r.key, r.workflowId])),
          openCases: await listOpenMonitoringCases(db, org.id),
        };
      });

      for (const record of current) {
        // An existing case row's stored workflow id wins over a freshly computed one: a case
        // opened before the org-qualified format still answers to `case-<key>`, and starting a
        // NEW execution for it would leave one drug with two workflows and a case row tracking
        // only the older of them.
        const { started } = await startCase(
          client,
          org.id,
          record,
          record.sources,
          existingWorkflowIds.get(record.key),
        );
        if (started) opened += 1;
      }

      // Feed-resolution auto-detect (PHASE6 §6.6): close the lifecycle loop the deferred finding
      // flagged — the system opened cases but never noticed a shortage ended. Diff open
      // monitoring cases against this poll's keys; the pure `diffResolutions` owns the counting so
      // a single feed flap can never resolve a live case. Per org, because a hospital's cases are
      // its own: org A's heparin case must not be resolved by counting org B's misses.
      const diff = diffResolutions(
        openCases,
        { currentKeys, resolvedKeys },
        getEnv().FEED_RESOLVE_MISS_THRESHOLD,
        pollTimestamp,
      );
      await withOrgDb(org.id, async (db) => {
        for (const caseId of diff.toReset) await resetFeedMiss(db, org.id, caseId);
        for (const caseId of diff.toBump) await bumpFeedMiss(db, org.id, caseId, pollRun);
      });
      for (const evidence of diff.toResolve) {
        // ONE CASE'S FAILURE STOPS THAT CASE, NOT THE POLL. `markResolved` signals a Temporal
        // execution that may no longer exist — completed, terminated, or aged out of retention —
        // while the case ROW still sits in a monitoring status, which is an ordinary end state for
        // a 90-day workflow whose history was dropped. Unguarded, that rejection escapes
        // `pollAndOpenCases` entirely: every org LATER in the loop gets no case opened and no
        // resolution this cycle, `stopgap_feed_poll_success_total` never increments, and the
        // FeedStale runbook reads "the poller stopped" for what is one stale row in one tenant.
        // The escalation ladder already takes exactly this stance for the same hazard (a tier whose
        // notification activity rejects is recorded and the ladder keeps climbing); this is that
        // rule applied to the poll.
        //
        // Contained, not swallowed: the failure is logged with the case it belongs to, counted, and
        // — because `resetFeedMiss` is inside the same block — the miss counter is left ABOVE the
        // threshold, so the next poll retries this case rather than starting its count again.
        try {
          // Signal the durable workflow (it owns the state machine), record the evidence in the
          // tamper-evident chain, then clear the counter. The signal is addressed to the id the CASE
          // ROW carries, so a pre-migration case is still reachable. `runId` is the poll's run id so
          // a retry within one poll dedups on the idempotency key while a later recurrence's
          // resolution (a different poll run) still lands its own entry.
          await markResolved(client, evidence.workflowId);
          await withOrgDb(org.id, async (db) => {
            await appendAudit(db, {
              orgId: org.id,
              caseId: evidence.caseId,
              actor: "system",
              actorUserId: getSyntheticUser("system"),
              action: "case.feed_resolved",
              detail: {
                reason: evidence.reason,
                source: evidence.source,
                lastSeenSourceId: evidence.lastSeenSourceId,
                consecutiveMisses: evidence.consecutiveMisses,
                missPollTimestamps: evidence.missPollTimestamps,
              },
              runId: currentRunId(),
              eventKey: "case.feed_resolved",
            });
            await resetFeedMiss(db, org.id, evidence.caseId);
          });
          // Counted only on the path that actually resolved something. A case whose signal or audit
          // append failed did NOT resolve, and reporting it as resolved would be the faked success
          // this codebase refuses.
          resolved += 1;
        } catch (err) {
          incrementCounter("stopgap_feed_resolution_failures_total");
          console.error(
            `[poll] feed resolution failed for org ${org.id} case ${evidence.caseId} ` +
              `(workflow ${evidence.workflowId}): ${err instanceof Error ? err.message : String(err)}. ` +
              "The case stays monitoring and its miss counter is unchanged, so the next poll retries it.",
          );
        }
      }
    }
    // A completed poll is a liveness signal for the scheduler (PHASE6 §6.4): the FeedStale alert's
    // runbook checks this counter to tell "the feed went quiet" from "the poller stopped running".
    incrementCounter("stopgap_feed_poll_success_total");
    // `polled` is the deployment's view of the feed (one snapshot), while `opened`/`resolved` are
    // summed across tenants — a poll that opens the same drug for two hospitals really did do two
    // units of work, and reporting one would understate it.
    return { polled: current.length, opened, resolved };
  } finally {
    await connection.close();
  }
}

/**
 * Read a severity's escalation ladder for the workflow (PHASE6 §6.3). Returns the plain steps
 * array (serializable across the activity boundary) or null when no ladder is configured for the
 * severity — the workflow then simply runs no escalation.
 *
 * NO `orgId` (PHASE6 §6.5). `escalation_policies` is a GLOBAL table: every org shares one ladder
 * per severity today, which `schema.ts` and `docs/multi-tenancy.md` both record as a deliberate
 * deferral rather than an oversight — making it per-org means widening
 * `escalation_policies_severity_uq` to `(org_id, severity)` and seeding a ladder for every new org,
 * and that is a change with its own migration, not a parameter added here.
 */
export async function getEscalationPolicy(
  severity: string,
): Promise<{ severity: string; steps: EscalationStep[] } | null> {
  const policy = await readEscalationPolicy(getDb(), severity);
  return policy ? { severity: policy.severity, steps: policy.steps } : null;
}

/**
 * Fire one escalation tier: page `notify` and record it in the audit chain (PHASE6 §6.3). The
 * notification is an automated, un-attributed action, so the audit actor is the synthetic `system`
 * user (actorUserId = system), never a human. A non-delivery (no recipients, transport down) is
 * recorded honestly and the ladder still advances — the same falsifiability stance as `sendComms`.
 * Idempotent on the case + run + step so a Temporal activity retry cannot double-page a tier.
 *
 * `notify` names a ROLE, and the tier's audience is whoever holds it — otherwise every tier would
 * land in the same pharmacy inbox and the ladder would change only its timing, not who is paged.
 * The resolved addresses go into the audit detail so "we tried to page the director" is checkable
 * against a concrete list, and a role nobody holds is a recorded non-delivery, not a silent
 * fallback to the pharmacy list.
 */
export async function sendEscalationNotification(input: {
  orgId: string;
  key: string;
  severity: string;
  stepIndex: number;
  notify: string;
  afterMinutes: number;
}): Promise<{ delivered: boolean }> {
  const { orgId } = input;
  // The recipients are resolved WITHIN the org: `listRoleRecipients` reads `users`, so paging
  // "whoever holds pharmacy_director" must mean this hospital's director. Un-scoped, the ladder
  // would mail another tenant's staff about a shortage in a building they do not work in.
  const { row, recipients } = await withOrgDb(orgId, async (db) => ({
    row: await getCaseByKey(db, orgId, input.key),
    recipients: await listRoleRecipients(db, orgId, input.notify),
  }));
  const workflowId = row?.workflowId ?? workflowIdForKey(orgId, input.key);
  const result =
    recipients.length > 0
      ? await sendEmail({
          idempotencyKey: `${workflowId}:${currentRunId() ?? "no-run"}:escalation:${String(input.stepIndex)}`,
          subject: `Escalation (${input.severity}) — ${input.key}: notify ${input.notify}`,
          body:
            `Shortage case ${input.key} (severity ${input.severity}) is unacknowledged ` +
            `${String(input.afterMinutes)} minutes after escalation began. Escalating to ${input.notify}. ` +
            `Acknowledge in the console to stop the ladder.`,
          to: recipients,
        })
      : {
          channel: "email" as const,
          delivered: false,
          reason: `no user holds role ${input.notify}`,
        };
  incrementCounter(
    result.delivered ? "stopgap_comms_delivered_total" : "stopgap_comms_nondelivered_total",
    { channel: "escalation" },
  );
  await withOrgDb(orgId, (db) =>
    appendAudit(db, {
      orgId,
      caseId: row?.id,
      actor: "system",
      actorUserId: getSyntheticUser("system"),
      action: "escalation.notified",
      detail: {
        severity: input.severity,
        step: input.stepIndex,
        notify: input.notify,
        recipients,
        afterMinutes: input.afterMinutes,
        delivered: result.delivered,
        reason: result.reason,
      },
      runId: currentRunId(),
      // Keyed by step so each tier appends once per run; a retry of the same tier is a no-op.
      eventKey: `escalation.notified.step-${String(input.stepIndex)}`,
    }),
  );
  return { delivered: result.delivered };
}

/**
 * Record a human acknowledgment (PHASE6 §6.3): write the `acknowledgments` row and, only if it was
 * a NEW ack (not a duplicate for the same tier), append `case.acknowledged` to the audit chain with
 * the AUTHENTICATED user id — the console threaded the session's `users.id` through the signal, so
 * "who saw this" is machine-checkable, never a claimed string. Idempotent on `(case, step)`.
 */
export async function recordAck(input: {
  orgId: string;
  key: string;
  userId: string;
  label: string;
  step: number;
}): Promise<void> {
  const { orgId } = input;
  await withOrgDb(orgId, async (db) => {
    const row = await getCaseByKey(db, orgId, input.key);
    if (!row) return;
    const inserted = await recordAcknowledgment(db, {
      orgId,
      caseId: row.id,
      userId: input.userId,
      step: input.step,
    });
    if (!inserted) return; // already acknowledged at this tier — no second audit claim.
    await appendAudit(db, {
      orgId,
      caseId: row.id,
      actor: input.label,
      actorUserId: input.userId,
      action: "case.acknowledged",
      detail: { step: input.step, identitySource: "authenticated-session" },
      runId: currentRunId(),
      eventKey: `case.acknowledged.step-${String(input.step)}`,
    });
  });
}

/**
 * Take one external anchor of EVERY organization's chain head (PHASE6 §6.2, per-org since §6.5
 * pass 2). Runs on its own hourly Temporal schedule (see `scripts/start-schedule.ts`). An org with
 * an empty chain contributes nothing — an anchor never claims to have pinned something that does
 * not exist — so a fresh deployment honestly returns an empty list rather than a fabricated row.
 *
 * Deployment-wide by design, and the only activity besides the feed poll that is: the chain is
 * per-tenant but the INTEGRITY GUARANTEE is not something a tenant may opt out of. It therefore
 * runs through `withBypassDb`, which uses the maintenance pool (`DATABASE_URL_MAINTENANCE`).
 *
 * IT REFUSES TO RUN ON A CONNECTION THE POLICIES APPLY TO, rather than degrading. On such a
 * connection every per-org head query returns zero rows, so this activity would return an empty
 * list, Temporal would record a successful hourly anchor, and tamper-evidence would quietly stop
 * accumulating with nothing anywhere reporting a problem. "Anchored nothing" and "there was nothing
 * to anchor" are indistinguishable in the return value, which is exactly why the distinction is
 * enforced before the work starts instead of inferred from it afterwards.
 */
export async function anchorAuditChain(): Promise<
  { orgId: string; maxAuditId: number; headHash: string; sink: string }[]
> {
  await assertMaintenanceRoleBypassesRls("anchorAuditChain");
  const orgs = await withBypassDb(() => listOrganizations());
  const rows = await withBypassDb((db) =>
    runAuditAnchor(
      db,
      orgs.map((o) => o.id),
    ),
  );
  return rows.map((row) => ({
    orgId: row.orgId,
    maxAuditId: row.maxAuditId,
    headHash: row.headHash,
    sink: row.sink,
  }));
}

/**
 * Read the configured windows, translating the "never sweep this" sentinel.
 *
 * A NEGATIVE env value means keep forever; `retentionPlan` refuses a negative window outright, so
 * the sentinel is converted here rather than being allowed anywhere near the cutoff arithmetic.
 * Zero is left alone and means what it says: sweep everything older than this instant.
 */
function retentionWindowsFromEnv(env: ReturnType<typeof getEnv>): RetentionWindows {
  const window = (days: number) => (days < 0 ? RETAINED_FOREVER : days);
  return {
    riskSignals: window(env.RETENTION_SIGNAL_DAYS),
    riskScoreSnapshots: window(env.RETENTION_SCORE_SNAPSHOT_DAYS),
    alertEvents: window(env.RETENTION_ALERT_EVENT_DAYS),
    inventorySnapshots: window(env.RETENTION_INVENTORY_SNAPSHOT_DAYS),
    procurementEvents: window(env.RETENTION_PROCUREMENT_EVENT_DAYS),
  };
}

/**
 * The retention sweep (ticket 18) — one run removes every organization's expired records.
 *
 * On the DURABLE runtime, as an activity of a scheduled workflow, because a second scheduler is a
 * second thing that can silently stop: Temporal already reports a schedule that has not fired, and
 * a cron entry on one host does not.
 *
 * ONE TENANT'S FAILURE MUST NOT STOP THE SWEEP, the same containment the poll applies. A sweep
 * that abandoned every later organization because one hit a lock would quietly leave most of the
 * deployment ungoverned while reporting a single error.
 */
export async function sweepRetention(): Promise<RetentionSweepResult[]> {
  const env = getEnv();
  const windows = retentionWindowsFromEnv(env);
  const orgs = await withBypassDb(() => listOrganizations());
  // ONE instant for the whole run, not one per org: cutoffs computed from a moving clock would
  // make two tenants' sweeps incomparable and the run irreproducible from its own audit entries.
  const now = new Date();
  // Stable across retries of this activity's execution, so a retried sweep's audit entries name
  // the same run rather than looking like a second cleanup.
  const runToken = currentRunId() ?? now.toISOString();
  const results: RetentionSweepResult[] = [];
  for (const org of orgs) {
    try {
      const result = await sweepOrgRetention(org.id, now, windows, runToken);
      results.push(result);
      const removed = totalRemoved(result.counts);
      if (removed > 0) console.log(`[retention] org ${org.id}: removed ${removed} rows`, result.counts);
      incrementCounter("stopgap_retention_success_total");
    } catch (err) {
      incrementCounter("stopgap_retention_failures_total");
      console.error(
        `[retention] sweep failed for org ${org.id}: ${err instanceof Error ? err.message : String(err)}. ` +
          "That tenant keeps its expired rows and the next scheduled run retries it; every other " +
          "organization in this run continues.",
      );
    }
  }
  return results;
}


/**
 * Look up the approved protocol for this shortage key — the organizational-memory read
 * (PROJECT_PLAN §3B/§4). A hit means a pharmacist already approved substitution guidance for
 * this drug, so the case reuses it instead of paying for a fresh research call and asking a
 * human to re-approve text they already wrote.
 */
export async function lookupProtocol(
  orgId: string,
  key: string,
): Promise<ProtocolMemoryHit | undefined> {
  // Organizational memory is exactly that — ONE organization's. A protocol another hospital's
  // pharmacist approved is not guidance this hospital has adopted, and reusing it would put text
  // nobody here signed off on in front of a clinician.
  const found = await withOrgDb(orgId, (db) => getApprovedProtocol(orgId, key, db));
  if (!found) return undefined;
  return {
    versionId: found.version.id,
    version: found.version.version,
    body: found.version.body,
    alternatives: found.version.alternatives,
  };
}

/**
 * Write the approved outcome of this case back into the protocol store, then approve it —
 * this is what turns a one-off resolution into organizational memory. Provenance (source
 * case, author, approver, rationale) is recorded on the version row.
 */
export async function recordProtocolVersion(input: RecordProtocolInput): Promise<void> {
  const { orgId } = input;
  await withOrgDb(orgId, async (db) => {
    const row = await getCaseByKey(db, orgId, input.key);
    // Idempotent under retry: an activity whose insert committed before the worker crashed
    // would otherwise write a second identical version and supersede the one it just approved.
    // The retry still re-appends the audit entry (itself idempotent) — a crash between the
    // approval commit and the audit append would otherwise leave an approved protocol version
    // with no record of who approved it.
    // Resolve the machine-checkable ids here (the activity, which may touch the DB) rather than in
    // the deterministic workflow (which must never import @stopgap/db). An explicit id from an
    // authenticated session wins; otherwise a `system`/`agent` label maps to its synthetic user,
    // and a human label with no threaded session stays NULL.
    const authoredByUserId = input.authoredByUserId ?? syntheticUserIdForLabel(input.authoredBy);
    const approvedByUserId = input.approvedByUserId ?? syntheticUserIdForLabel(input.approvedBy);
    const current = await getApprovedProtocol(orgId, input.key, db);
    if (current && current.version.body === input.body) {
      await appendAudit(db, {
        orgId,
        caseId: row?.id,
        actor: input.approvedBy,
        actorUserId: approvedByUserId,
        action: "protocol.version_approved",
        detail: {
          key: input.key,
          version: current.version.version,
          authoredBy: input.authoredBy,
          identitySource: input.approvedByUserId
            ? "authenticated-session"
            : "workflow-signal-claim",
        },
        runId: currentRunId(),
        eventKey: `protocol.version_approved.v${String(current.version.version)}`,
      });
      return;
    }
    const drafted = await draftProtocolVersion(
      {
        orgId,
        key: input.key,
        title: input.title,
        body: input.body,
        alternatives: input.alternatives,
        sourceCaseId: row?.id ?? null,
        authoredBy: input.authoredBy,
        authoredByUserId: authoredByUserId ?? null,
        rationale: input.rationale ?? null,
      },
      db,
    );
    await approveProtocolVersion(orgId, drafted.id, input.approvedBy, approvedByUserId ?? null, db);
    await appendAudit(db, {
      orgId,
      caseId: row?.id,
      actor: input.approvedBy,
      // Real `users.id` when the console approved through an authenticated session (PHASE6 §6.1);
      // the free-text `approvedBy`/`authoredBy` stay recorded as the human labels. A CLI signal
      // without a session leaves the FK NULL rather than faking a principal.
      actorUserId: approvedByUserId,
      action: "protocol.version_approved",
      detail: {
        key: input.key,
        version: drafted.version,
        authoredBy: input.authoredBy,
        identitySource: input.approvedByUserId ? "authenticated-session" : "workflow-signal-claim",
      },
      runId: currentRunId(),
      eventKey: `protocol.version_approved.v${String(drafted.version)}`,
    });
  });
}

/**
 * The daily brief (ticket 13). Lives in `brief.ts` and is re-exported here because the worker
 * registers `* as activities` — an activity the worker cannot see is a schedule that fails at run
 * time rather than at build time.
 */
export { generateDailyBriefs } from "./brief.js";
