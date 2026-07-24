import "server-only";
import {
  feedFreshness,
  getCaseByWorkflowId,
  getDb,
  listAcknowledgments,
  listCases,
  listShadowRuns,
  listUsers,
  schema,
  shadowStatsByClass,
  verifyAnchors,
  verifyAuditChain,
} from "@stopgap/db";
import type { Role } from "@stopgap/core";
import type { UserRow } from "@stopgap/db";
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
import { evaluatePromotion, type PromotionDecision } from "@stopgap/shadow";
import { getCaseState, withTemporalClient, type CaseState } from "@stopgap/workflows";
import { desc, eq, inArray } from "drizzle-orm";

/** When each feed last returned data — the list view's freshness line. */
export async function getFeedFreshness(): Promise<FeedFreshness[]> {
  return feedFreshness(getDb());
}

/** All cases, newest-touched first (list view). */
export async function getCases(): Promise<CaseRow[]> {
  return listCases(getDb(), 200);
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
  const db = getDb();
  const row = await getCaseByWorkflowId(db, workflowId);
  if (!row) return undefined;
  const audit = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.caseId, row.id))
    .orderBy(desc(schema.auditLog.id));
  const ackRows = await listAcknowledgments(db, row.id);
  // Resolve each acking user's label in one query rather than per-row. A missing user row (never
  // expected — the FK enforces it) degrades to showing the id, never a crash.
  const userIds = [...new Set(ackRows.map((a) => a.userId))];
  const userRows = userIds.length
    ? await db
        .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds))
    : [];
  const labelById = new Map(userRows.map((u) => [u.id, u.email ?? u.displayName ?? u.id]));
  const acks: CaseAck[] = ackRows.map((a) => ({
    step: a.step,
    ackAt: a.ackAt,
    userId: a.userId,
    ackedByLabel: labelById.get(a.userId) ?? a.userId,
  }));
  return { case: row, audit, acks };
}

/**
 * Live workflow state for a case — the draft text and proposed alternatives live in the
 * running workflow, not in Postgres (the DB mirrors status transitions, not agent output).
 * Returns undefined when the workflow is gone or unreachable so the page still renders the
 * durable half rather than 500-ing on a stopped worker.
 */
export async function getWorkflowState(key: string): Promise<CaseState | undefined> {
  // `makeClient` is inside the try on purpose: a stopped Temporal server throws on connect,
  // and that is exactly the unreachable case this function promises to survive.
  try {
    return await withTemporalClient((client) => getCaseState(client, key));
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
  const db = getDb();
  const [chain, anchors] = await Promise.all([verifyAuditChain(db), verifyAnchors(db)]);
  return { chain, anchors };
}

/** Active users with their roles, for the admin management page (PHASE6 §6.1). */
export async function getUsers(): Promise<(UserRow & { roles: Role[] })[]> {
  return listUsers();
}

/** Shadow-mode aggregates per drug class, with the promotion stage each has earned. */
export async function getShadowDashboard(): Promise<
  { stats: ShadowClassStats; decision: PromotionDecision }[]
> {
  const stats = await shadowStatsByClass();
  return stats
    .map((s) => ({ stats: s, decision: evaluatePromotion(s) }))
    .sort((a, b) => b.stats.runs - a.stats.runs);
}

/** The most recent shadow runs, for disagreement triage. */
export async function getShadowRuns(limit = 50): Promise<ShadowRunRow[]> {
  return listShadowRuns(limit);
}

/** Every version of every protocol the organization has approved, newest first. */
export async function getProtocols(): Promise<
  { protocol: ProtocolRow; versions: ProtocolVersionRow[] }[]
> {
  const db = getDb();
  const rows = await db.select().from(schema.protocols).orderBy(desc(schema.protocols.updatedAt));
  if (rows.length === 0) return [];
  // One query for every version, grouped in memory — a per-protocol lookup would re-find the
  // protocol row this function already holds, twice per protocol per page render.
  const versions = await db
    .select()
    .from(schema.protocolVersions)
    .orderBy(desc(schema.protocolVersions.version));
  return rows.map((protocol) => ({
    protocol,
    versions: versions.filter((version) => version.protocolId === protocol.id),
  }));
}
