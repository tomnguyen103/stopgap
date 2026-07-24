import "server-only";
import {
  feedFreshness,
  getCaseByWorkflowId,
  getDb,
  listAcknowledgments,
  listApiKeys,
  listCases,
  listOrganizations,
  listShadowRuns,
  listUsers,
  schema,
  shadowStatsByClass,
  verifyAnchors,
  verifyAuditChain,
  withOrgDb,
} from "@stopgap/db";
import type { Role } from "@stopgap/core";
import type { ApiKeyRow, UserRow } from "@stopgap/db";
import type {
  AnchorVerification,
  AuditRow,
  ChainVerification,
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
import { and, desc, eq, inArray } from "drizzle-orm";
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

/** All cases in the caller's org, newest-touched first (list view). */
export async function getCases(): Promise<CaseRow[]> {
  const orgId = await currentOrgId();
  return withOrgDb(orgId, (db) => listCases(db, orgId, 200));
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
          .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
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
