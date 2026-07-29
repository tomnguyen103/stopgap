import "server-only";
import {
  feedFreshness,
  dailyCounts,
  getCaseByWorkflowId,
  getLlmSpend,
  listAlertHistory,
  lastFiredByRule,
  listAlertRules,
  unacknowledgedCritical,
  getDb,
  getKpis,
  getSignalByKey,
  latestScoresForSignals,
  listCaseQueue,
  listEvidenceForSignal,
  listSignalsPage,
  listAcknowledgments,
  listApiKeys,
  listDailyBriefs,
  listOrganizations,
  listShadowRuns,
  listUsers,
  rankedOpenCases,
  schema,
  shadowStatsByClass,
  verifyAnchors,
  verifyAuditChain,
  withOrgDb,
} from "@stopgap/db";
import type { CaseStatus, Role } from "@stopgap/core";
import type {
  AlertHistoryOptions,
  AlertHistoryRow,
  AlertRuleRow,
  ApiKeyRow,
  DailyCount,
  DailySpend,
  UnacknowledgedCase,
  Kpis,
  CaseQueueOptions,
  QueuedCase,
  RankedCase,
  RiskSignalRow,
  SignalEvidenceRow,
  SignalPageOptions,
  UserRow,
} from "@stopgap/db";
import type {
  AnchorVerification,
  AuditRow,
  ChainVerification,
  DailyBriefRow,
  FeedFreshness,
  CaseRow,
  ProtocolRow,
  ProtocolVersionRow,
  ShadowClassStats,
  ShadowRunRow,
} from "@stopgap/db";
import type { OrganizationRow } from "@stopgap/db";
import { evaluatePromotion, type PromotionDecision } from "@stopgap/shadow";
import { getCaseState, withTemporalClient, type CaseState } from "@stopgap/workflows";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { resolvePrincipal } from "./principal";

/**
 * TENANT SCOPING FOR EVERY CONSOLE READ (PHASE6 §6.5).
 *
 * None of these functions takes an org from its caller, and that is the design. The org comes from
 * `resolvePrincipal()` — the same server-side resolution the mutating actions use — so a page
 * cannot render another tenant's data by passing the wrong argument, because there is no argument
 * to pass. Every query then runs inside `withOrgDb`, which sets `app.current_org` for the
 * transaction, so the RLS policies are exercised on the real read path rather than only in the
 * migration.
 *
 * The one read that stays deliberately UNSCOPED is `getFeedFreshness`: `feed_records` is a GLOBAL
 * table (see `schema.ts`) because one openFDA snapshot is one physical fact about the drug supply,
 * identical for every hospital.
 */
async function currentOrgId(): Promise<string> {
  return (await resolvePrincipal()).orgId;
}

/**
 * When each feed last returned data — the list view's freshness line. Deliberately NOT org-scoped:
 * `feed_records` is global, and per-org copies of one external fact would report the same number N
 * times while implying an isolation the underlying data does not have.
 */
export async function getFeedFreshness(): Promise<FeedFreshness[]> {
  return feedFreshness(getDb());
}

/** An acknowledgment with the acking user's human label resolved, for the escalation timeline. */
export interface CaseAck {
  step: number;
  ackAt: Date;
  userId: string;
  /** Email/display name of the acking user, or the raw id when the user row is gone. */
  ackedByLabel: string;
}

/** One case plus its hash-chained audit trail and escalation acknowledgments (detail view). */
export async function getCaseDetail(
  workflowId: string,
): Promise<{ case: CaseRow; audit: AuditRow[]; acks: CaseAck[] } | undefined> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const row = await getCaseByWorkflowId(db, orgId, workflowId);
    if (!row) return undefined;
    const audit = await db
      .select()
      .from(schema.auditLog)
      // The org predicate is explicit even though the case id already implies it and RLS would hide
      // the rest: an audit trail is the one view where "we showed you everything that happened" must
      // be true of exactly one tenant's chain.
      .where(and(eq(schema.auditLog.orgId, orgId), eq(schema.auditLog.caseId, row.id)))
      .orderBy(desc(schema.auditLog.id));
    const ackRows = await listAcknowledgments(db, orgId, row.id);
    // Resolve each acking user's label in one query rather than per-row. A missing user row (never
    // expected — the FK enforces it) degrades to showing the id, never a crash.
    const userIds = [...new Set(ackRows.map((a) => a.userId))];
    const userRows = userIds.length
      ? await db
          .select({
            id: schema.users.id,
            email: schema.users.email,
            displayName: schema.users.displayName,
          })
          .from(schema.users)
          .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, userIds)))
      : [];
    // Display name first: the timeline is rendered to every console viewer of the case, so a
    // human-readable label is preferable to spreading email addresses across case pages.
    const labelById = new Map(userRows.map((u) => [u.id, u.displayName ?? u.email ?? u.id]));
    const acks: CaseAck[] = ackRows.map((a) => ({
      step: a.step,
      ackAt: a.ackAt,
      userId: a.userId,
      ackedByLabel: labelById.get(a.userId) ?? a.userId,
    }));
    return { case: row, audit, acks };
  });
}

/**
 * Live workflow state for a case — the draft text and proposed alternatives live in the
 * running workflow, not in Postgres (the DB mirrors status transitions, not agent output).
 * Returns undefined when the workflow is gone or unreachable so the page still renders the
 * durable half rather than 500-ing on a stopped worker.
 */
export async function getWorkflowState(workflowId: string): Promise<CaseState | undefined> {
  // Takes the id the CASE ROW carries, not a key to recompute from (PHASE6 §6.5): a case opened
  // before the org-qualified format answers only to `case-<key>`, and querying a recomputed id
  // would throw "workflow not found" for every pre-migration case — which this function would then
  // swallow as `undefined`, quietly hiding the live draft on the page a pharmacist reviews from.
  //
  // `makeClient` is inside the try on purpose: a stopped Temporal server throws on connect,
  // and that is exactly the unreachable case this function promises to survive.
  try {
    return await withTemporalClient((client) => getCaseState(client, workflowId));
  } catch {
    return undefined;
  }
}

/**
 * Audit-chain integrity for the verification page (PHASE6 §6.2): the overall chain result
 * (green, or the first broken row id) plus every stored external anchor with whether its
 * pinned head still matches the live chain. Read-only — safe in demo mode as a viewer.
 */
export async function getAuditIntegrity(): Promise<{
  chain: ChainVerification;
  anchors: AnchorVerification[];
}> {
  const orgId = await currentOrgId();
  // BOTH halves are this org's (PHASE6 §6.5). The chain is per-tenant, and since migration 0014 so
  // are the anchors — showing a pharmacist another hospital's anchors would be a leak, and
  // comparing this org's chain against another org's anchor would be a mismatch that is not
  // tampering. Verifying every org is a deployment-wide job and lives in `pnpm verify-audit`,
  // which runs under the BYPASSRLS maintenance role.
  return withOrgDb(orgId, async (db) => {
    const [chain, anchors] = await Promise.all([
      verifyAuditChain(db, orgId),
      verifyAnchors(db, undefined, orgId),
    ]);
    return { chain, anchors };
  });
}

/** Active users with their roles, for the admin management page (PHASE6 §6.1). */
export async function getUsers(): Promise<(UserRow & { roles: Role[] })[]> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listUsers(orgId, db));
}

/**
 * Every organization, for the admin active-org switcher (PHASE6 §6.5).
 *
 * Unscoped by necessity and by design: `organizations` carries no RLS policy, because a session
 * must resolve its own org before `app.current_org` can be set, and an isolation policy on the
 * table that defines isolation is a chicken-and-egg with no exit. It holds no tenant data — only
 * ids, slugs and names. Who may ACT on this list is enforced elsewhere: `setActiveOrgAction`
 * requires `admin` server-side, and the switcher is not rendered for anyone else.
 */
export async function getOrganizations(): Promise<OrganizationRow[]> {
  return listOrganizations();
}

/**
 * Every API key — including revoked ones — for the admin page (PHASE6 §6.7). Rows carry only the
 * hash and prefix, never a usable secret, so rendering them leaks nothing.
 */
export async function getApiKeys(): Promise<ApiKeyRow[]> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listApiKeys(orgId, db));
}

/**
 * This tenant's recent daily briefs, newest first (ticket 13).
 *
 * Tenant-scoped like every other read here: the org comes from the session, never from the caller,
 * so a brief written for one hospital cannot be read by another.
 */
export async function getDailyBriefs(limit = 30): Promise<DailyBriefRow[]> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listDailyBriefs(db, orgId, limit));
}

/** Shadow-mode aggregates per drug class, with the promotion stage each has earned. */
export async function getShadowDashboard(): Promise<
  { stats: ShadowClassStats; decision: PromotionDecision }[]
> {
  const orgId = await currentOrgId();
  const stats = await withOrgDb(orgId, (db) => shadowStatsByClass(orgId, db));
  return stats
    .map((s) => ({ stats: s, decision: evaluatePromotion(s) }))
    .sort((a, b) => b.stats.runs - a.stats.runs);
}

/** The most recent shadow runs, for disagreement triage. */
export async function getShadowRuns(limit = 50): Promise<ShadowRunRow[]> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listShadowRuns(orgId, limit, db));
}

/** Every version of every protocol the organization has approved, newest first. */
export async function getProtocols(): Promise<
  { protocol: ProtocolRow; versions: ProtocolVersionRow[] }[]
> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    // Explicit org predicates on BOTH selects. Pass 1 added `org_id` to these tables but this
    // function still read them unfiltered, relying entirely on RLS — which works, and which is
    // exactly the silent arrangement `cases.ts` argues against: a query with no scope of its own
    // becomes another hospital's protocol library the day something runs as a bypassing role.
    const rows = await db
      .select()
      .from(schema.protocols)
      .where(eq(schema.protocols.orgId, orgId))
      .orderBy(desc(schema.protocols.updatedAt));
    if (rows.length === 0) return [];
    // One query for every version, grouped in memory — a per-protocol lookup would re-find the
    // protocol row this function already holds, twice per protocol per page render.
    const versions = await db
      .select()
      .from(schema.protocolVersions)
      .where(eq(schema.protocolVersions.orgId, orgId))
      .orderBy(desc(schema.protocolVersions.version));
    return rows.map((protocol) => ({
      protocol,
      versions: versions.filter((version) => version.protocolId === protocol.id),
    }));
  });
}

/**
 * The viewer overview's three headline figures and its ranked queue, in one round trip's worth of
 * scope (ticket 08).
 *
 * `awaitingReview` is counted here rather than added to `Kpis`: that type is the KPI board's
 * contract and every consumer of it would otherwise gain a field it does not use.
 */
export interface ViewerOverview {
  kpis: Kpis;
  awaitingReview: number;
  ranked: RankedCase[];
  /**
   * The component map of this tenant's most recent snapshot — what the dormant-score notice is
   * read from.
   *
   * Deliberately the LATEST snapshot rather than one of the ranked rows: which components the
   * scorer can currently fill is a property of the scorer's inputs, not of whichever case happens
   * to rank first, and sampling a row means the notice disappears the moment that row is unscored.
   */
  latestComponents: Record<string, number> | null;
}

const AWAITING_REVIEW: CaseStatus = "awaiting_review";

export async function getViewerOverview(q: string | null = null): Promise<ViewerOverview> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const kpis = await getKpis(orgId, db);
    const [awaiting] = await db
      .select({ count: sql<string>`count(*)` })
      .from(schema.cases)
      .where(and(eq(schema.cases.orgId, orgId), eq(schema.cases.status, AWAITING_REVIEW)));
    const [newest] = await db
      .select({ components: schema.riskScoreSnapshots.components })
      .from(schema.riskScoreSnapshots)
      .where(eq(schema.riskScoreSnapshots.orgId, orgId))
      .orderBy(
        desc(schema.riskScoreSnapshots.computedAt),
        desc(schema.riskScoreSnapshots.id),
      )
      .limit(1);
    return {
      kpis,
      awaitingReview: Number(awaiting?.count ?? 0),
      ranked: await rankedOpenCases(db, orgId, q),
      latestComponents: (newest?.components ?? null) as Record<string, number> | null,
    };
  });
}

/** One page of the tenant's signals, each carrying its latest score if the scorer has reached it. */
export interface ScoredSignal {
  signal: RiskSignalRow;
  score: { score: number; band: string; scorerVersion: string } | undefined;
}

export async function getSignalsPage(
  options: SignalPageOptions,
): Promise<{ rows: ScoredSignal[]; total: number; page: number }> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const { rows, total, page } = await listSignalsPage(db, orgId, options);
    // ONE score lookup for the whole page. Per-row lookups turn a 100-row page into 100 round
    // trips, which is the shape that makes paging pointless.
    const scores = await latestScoresForSignals(
      db,
      orgId,
      rows.map((row) => row.id),
    );
    return { rows: rows.map((signal) => ({ signal, score: scores.get(signal.id) })), total, page };
  });
}

/** One signal with its evidence and its latest score snapshot, for the detail view. */
export async function getSignalDetail(dedupeKey: string): Promise<
  | {
      signal: RiskSignalRow;
      snapshot: schema.RiskScoreSnapshotRow | undefined;
    }
  | undefined
> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const signal = await getSignalByKey(db, orgId, dedupeKey);
    if (!signal) return undefined;
    const [snapshot] = await db
      .select()
      .from(schema.riskScoreSnapshots)
      .where(
        and(
          eq(schema.riskScoreSnapshots.orgId, orgId),
          eq(schema.riskScoreSnapshots.signalId, signal.id),
        ),
      )
      .orderBy(desc(schema.riskScoreSnapshots.computedAt), desc(schema.riskScoreSnapshots.id))
      .limit(1);
    return { signal, snapshot };
  });
}

/** One page of the pharmacist's review queue, ranked by risk score (ticket 11). */
export async function getCaseQueue(
  options: CaseQueueOptions,
): Promise<{ rows: QueuedCase[]; total: number; page: number }> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listCaseQueue(db, orgId, options));
}

/**
 * The evidence trail behind a case, via the signal that names the same product.
 *
 * Returns an empty array rather than throwing when nothing matches: a case the feeds have not
 * classified has no evidence yet, which is a thing the drawer says, not an error.
 */
export async function getCaseEvidence(genericName: string): Promise<{
  signal: RiskSignalRow | undefined;
  evidence: SignalEvidenceRow[];
}> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    // ONE ROW PER SIGNAL, its LATEST snapshot — the same `distinct on` the queue's `rankedOpenCases`
    // ranks by. Joining the snapshot table directly would put every historical score in the sort and
    // let a signal's old peak outrank another signal's current one, so the evidence card would name
    // a signal the queue did not rank the case on: the page contradicting itself, which is exactly
    // what ordering by the ranked score is here to prevent.
    const latestSnapshot = db
      .selectDistinctOn([schema.riskScoreSnapshots.signalId], {
        signalId: schema.riskScoreSnapshots.signalId,
        score: schema.riskScoreSnapshots.score,
        reachableMax: schema.riskScoreSnapshots.reachableMax,
      })
      .from(schema.riskScoreSnapshots)
      .where(eq(schema.riskScoreSnapshots.orgId, orgId))
      .orderBy(
        schema.riskScoreSnapshots.signalId,
        desc(schema.riskScoreSnapshots.computedAt),
        // `id` last, so two snapshots computed in the same instant resolve to a stable one.
        desc(schema.riskScoreSnapshots.id),
      )
      .as("latest_snapshot");
    // The signal the RANK came from — highest latest score first, then the SAME tiebreak the queue
    // uses (`rankedOpenCases` breaks a fraction tie on `dedupe_key`). Two signals for one product can
    // hold the same fraction, and breaking that tie differently here would name a different signal
    // than the queue ranked the case on — the contradiction this ordering exists to prevent. `id`
    // last so the pick is stable across renders even when every other key ties.
    const [signal] = await db
      .select({ signal: schema.riskSignals })
      .from(schema.riskSignals)
      .leftJoin(latestSnapshot, eq(latestSnapshot.signalId, schema.riskSignals.id))
      .where(
        and(
          eq(schema.riskSignals.orgId, orgId),
          sql`lower(${schema.riskSignals.entityIdentifier}) = lower(${genericName})`,
        ),
      )
      .orderBy(
        sql`${latestSnapshot.score} / nullif(${latestSnapshot.reachableMax}, 0) desc nulls last`,
        schema.riskSignals.dedupeKey,
        desc(schema.riskSignals.publishedAt),
        desc(schema.riskSignals.id),
      )
      .limit(1)
      .then((rows) => rows.map((row) => row.signal));
    if (!signal) return { signal: undefined, evidence: [] };
    return { signal, evidence: await listEvidenceForSignal(db, orgId, signal.id) };
  });
}

/** The director's oversight figures (ticket 14). */
export interface OversightData {
  kpis: Kpis;
  trend: DailyCount[];
  unacknowledged: UnacknowledgedCase[];
  spend: DailySpend;
  pendingVersions: {
    protocol: ProtocolRow;
    version: ProtocolVersionRow;
    previousBody: string;
    supersedes: number | null;
  }[];
}

export async function getOversight(): Promise<OversightData> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const [kpis, trend, unacknowledged, spend] = await Promise.all([
      getKpis(orgId, db),
      dailyCounts(db, orgId),
      unacknowledgedCritical(db, orgId),
      getLlmSpend(db),
    ]);
    // Drafted versions waiting on a director, each paired with the approved text it would replace
    // — which is what makes "what changed" answerable without a second round trip per row.
    const rows = await db
      .select({ protocol: schema.protocols, version: schema.protocolVersions })
      .from(schema.protocolVersions)
      .innerJoin(
        schema.protocols,
        and(
          eq(schema.protocols.orgId, orgId),
          eq(schema.protocols.id, schema.protocolVersions.protocolId),
        ),
      )
      .where(
        and(eq(schema.protocolVersions.orgId, orgId), eq(schema.protocolVersions.state, "draft")),
      )
      .orderBy(desc(schema.protocolVersions.createdAt));
    // The approved version each draft would replace. `DISTINCT ON` with an explicit order, not a
    // bare filter: `approveProtocolVersion` supersedes the previous approval in the same
    // transaction so there should be one per protocol, and "should be" is not an ordering — an
    // unordered read would let the planner pick either row on any day the invariant slipped.
    const approved = await db
      .selectDistinctOn([schema.protocolVersions.protocolId], {
        protocolId: schema.protocolVersions.protocolId,
        version: schema.protocolVersions.version,
        body: schema.protocolVersions.body,
      })
      .from(schema.protocolVersions)
      .where(
        and(eq(schema.protocolVersions.orgId, orgId), eq(schema.protocolVersions.state, "approved")),
      )
      .orderBy(schema.protocolVersions.protocolId, desc(schema.protocolVersions.version));
    const approvedByProtocol = new Map(
      approved.map((row) => [row.protocolId, { body: row.body, version: row.version }]),
    );
    return {
      kpis,
      trend,
      unacknowledged,
      spend,
      pendingVersions: rows.map((row) => {
        const previous = approvedByProtocol.get(row.protocol.id);
        return {
          ...row,
          previousBody: previous?.body ?? "",
          // The version this draft would SUPERSEDE, read from the approved row rather than guessed
          // as "mine minus one" — with two drafts pending, that guess names another draft.
          supersedes: previous?.version ?? null,
        };
      }),
    };
  });
}

/** This tenant's alert rules with when each last fired, for the director's rules panel. */
export async function getAlertRules(): Promise<{
  rules: AlertRuleRow[];
  lastFired: Record<string, string>;
}> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, async (db) => {
    const rules = await listAlertRules(db, orgId);
    return {
      rules,
      // ONE query for the whole list, not one per rule: `lastFiredByRule` is a DISTINCT ON over the
      // events table and a per-row lookup would be a round trip per rule on every render.
      lastFired: await lastFiredByRule(
        db,
        orgId,
        rules.map((rule) => rule.id),
      ),
    };
  });
}

/** One page of alert history, with the rule that produced each event. */
export async function getAlertHistory(
  options: AlertHistoryOptions,
): Promise<{ rows: AlertHistoryRow[]; total: number; page: number }> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listAlertHistory(db, orgId, options));
}
