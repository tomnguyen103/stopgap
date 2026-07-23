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
export async function approveProtocolVersion(
  versionId: string,
  approvedBy: string,
): Promise<ProtocolVersionRow> {
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
    if (target.state === "approved") return target;
    if (target.state === "superseded") {
      throw new Error(`protocol version ${versionId} is superseded and cannot be approved`);
    }

    await tx
      .update(protocolVersions)
      .set({ state: "superseded" })
      .where(and(eq(protocolVersions.protocolId, target.protocolId), eq(protocolVersions.state, "approved")));

    const [approved] = await tx
      .update(protocolVersions)
      .set({ state: "approved", approvedBy, approvedAt: new Date() })
      .where(eq(protocolVersions.id, versionId))
      .returning();

    await tx.update(protocols).set({ updatedAt: new Date() }).where(eq(protocols.id, target.protocolId));
    return approved!;
  });
}
