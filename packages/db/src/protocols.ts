import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "./client.js";
import { protocols, protocolVersions } from "./schema.js";
import type { ProtocolRow, ProtocolVersionRow } from "./schema.js";

/**
 * Versioned protocol store (PROJECT_PLAN §3B — organizational memory). Versions are
 * immutable: approving a new one supersedes the previous approved version rather than
 * editing it, so "what did we tell the floor in March, and who approved it" stays answerable.
 */

export interface DraftProtocolInput {
  key: string;
  title: string;
  drugClass?: string | null;
  body: string;
  alternatives: string[];
  /** The case this draft came out of — the provenance link. */
  sourceCaseId?: string | null;
  /** "agent" for an agent draft, a pharmacist id for a human-authored one. */
  authoredBy: string;
  /** Authenticated author (PHASE6 §6.1), a real `users.id`, beside the free-text `authoredBy`. */
  authoredByUserId?: string | null;
  rationale?: string | null;
}

/** The protocol row for a shortage key, if one has ever been written. */
async function findProtocol(key: string): Promise<ProtocolRow | undefined> {
  const db = getDb();
  const [protocol] = await db.select().from(protocols).where(eq(protocols.key, key)).limit(1);
  return protocol;
}

/** The approved version a new case should reuse, or undefined if the protocol is unwritten. */
export async function getApprovedProtocol(
  key: string,
): Promise<{ protocol: ProtocolRow; version: ProtocolVersionRow } | undefined> {
  const db = getDb();
  const protocol = await findProtocol(key);
  if (!protocol) return undefined;
  const [version] = await db
    .select()
    .from(protocolVersions)
    .where(and(eq(protocolVersions.protocolId, protocol.id), eq(protocolVersions.state, "approved")))
    .orderBy(desc(protocolVersions.version))
    .limit(1);
  return version ? { protocol, version } : undefined;
}

/** One row of the protocol index: what a caller needs to decide which protocol to fetch in full. */
export interface ProtocolSummary {
  key: string;
  title: string;
  drugClass: string | null;
  /** The live version number, or null when every version is still a draft. */
  approvedVersion: number | null;
  updatedAt: Date;
}

/**
 * The protocol index, most recently updated first (PHASE6 §6.7).
 *
 * Exists because `getApprovedProtocol`/`listProtocolVersions` are both addressed BY key: without a
 * list, an integrator can only read protocols whose dedup keys they already know, which makes
 * "what guidance does this organization have?" unanswerable through the API — the console's own
 * protocols page could answer it and a client could not.
 *
 * The left join is safe to read as at-most-one row per protocol: `approveProtocolVersion` supersedes
 * the previous approved version inside the transaction that approves the next one, so a second
 * approved row for one protocol is a state that function guarantees cannot exist. If that invariant
 * ever broke, this list would fan out — which is the correct, visible failure, rather than silently
 * picking one of two rows that both claim to be live.
 */
export async function listProtocols(limit = 50): Promise<ProtocolSummary[]> {
  const db = getDb();
  return db
    .select({
      key: protocols.key,
      title: protocols.title,
      drugClass: protocols.drugClass,
      approvedVersion: protocolVersions.version,
      updatedAt: protocols.updatedAt,
    })
    .from(protocols)
    .leftJoin(
      protocolVersions,
      and(eq(protocolVersions.protocolId, protocols.id), eq(protocolVersions.state, "approved")),
    )
    .orderBy(desc(protocols.updatedAt))
    .limit(limit);
}

/** Every version of a protocol, newest first — the provenance/history view. */
export async function listProtocolVersions(key: string): Promise<ProtocolVersionRow[]> {
  const db = getDb();
  const protocol = await findProtocol(key);
  if (!protocol) return [];
  return db
    .select()
    .from(protocolVersions)
    .where(eq(protocolVersions.protocolId, protocol.id))
    .orderBy(desc(protocolVersions.version));
}

/**
 * Record a new draft version, creating the protocol on first use. Runs in one transaction:
 * the version number is derived from the current maximum, so two concurrent drafts can't
 * both claim version N (the `(protocol_id, version)` unique index is the backstop, turning
 * a lost race into a retryable error rather than a silently overwritten history).
 */
export async function draftProtocolVersion(input: DraftProtocolInput): Promise<ProtocolVersionRow> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(protocols).where(eq(protocols.key, input.key)).limit(1);
    const protocol =
      existing ??
      (
        await tx
          .insert(protocols)
          .values({ key: input.key, title: input.title, drugClass: input.drugClass ?? null })
          .returning()
      )[0]!;

    const [latest] = await tx
      .select({ version: protocolVersions.version })
      .from(protocolVersions)
      .where(eq(protocolVersions.protocolId, protocol.id))
      .orderBy(desc(protocolVersions.version))
      .limit(1);

    const [created] = await tx
      .insert(protocolVersions)
      .values({
        protocolId: protocol.id,
        version: (latest?.version ?? 0) + 1,
        state: "draft",
        body: input.body,
        alternatives: input.alternatives,
        sourceCaseId: input.sourceCaseId ?? null,
        authoredBy: input.authoredBy,
        authoredByUserId: input.authoredByUserId ?? null,
        rationale: input.rationale ?? null,
      })
      .returning();
    return created!;
  });
}

/**
 * Approve a draft: it becomes the live protocol and any previously approved version is
 * superseded in the same transaction, so there is never a moment with two approved versions
 * (or none) for the same protocol.
 */
/**
 * Result of an approval attempt. `changed` is false when the target was ALREADY approved (a
 * no-op): the caller uses it to avoid recording an audit entry claiming an approval that did not
 * happen (PHASE6 §6.1 — these console audits have no caseId, so appendAudit cannot dedupe them).
 */
export interface ApprovalResult {
  row: ProtocolVersionRow;
  changed: boolean;
}

export async function approveProtocolVersion(
  versionId: string,
  approvedBy: string,
  approvedByUserId?: string | null,
): Promise<ApprovalResult> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select()
      .from(protocolVersions)
      .where(eq(protocolVersions.id, versionId))
      .limit(1);
    if (!target) throw new Error(`protocol version ${versionId} not found`);
    // Serialize approvals per protocol. Without this lock two concurrent approvals both read
    // "no approved version" (each superseding what the other has not committed yet) and both
    // commit, leaving two approved versions — the exact state this function promises can
    // never exist.
    await tx.execute(sql`select id from ${protocols} where id = ${target.protocolId} for update`);
    if (target.state === "approved") return { row: target, changed: false };
    if (target.state === "superseded") {
      throw new Error(`protocol version ${versionId} is superseded and cannot be approved`);
    }

    await tx
      .update(protocolVersions)
      .set({ state: "superseded" })
      .where(and(eq(protocolVersions.protocolId, target.protocolId), eq(protocolVersions.state, "approved")));

    const [approved] = await tx
      .update(protocolVersions)
      .set({ state: "approved", approvedBy, approvedByUserId: approvedByUserId ?? null, approvedAt: new Date() })
      .where(eq(protocolVersions.id, versionId))
      .returning();

    await tx.update(protocols).set({ updatedAt: new Date() }).where(eq(protocols.id, target.protocolId));
    return { row: approved!, changed: true };
  });
}
