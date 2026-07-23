import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog } from "./schema.js";

/** Deterministic JSON: object keys sorted recursively so hashing is stable. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Genesis hash for an empty chain. */
export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  caseId?: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
}

function hashEntry(prevHash: string, e: Required<Omit<AuditEntry, "caseId">> & { caseId?: string }): string {
  return createHash("sha256")
    .update(prevHash)
    .update(canonical({ caseId: e.caseId ?? null, actor: e.actor, action: e.action, detail: e.detail }))
    .digest("hex");
}

/**
 * Append a hash-chained audit entry. Links to the previous row's hash so any later
 * tampering is detectable (see `verifyAuditChain`).
 *
 * The whole read-then-insert sequence runs inside a transaction serialized by a Postgres
 * advisory lock: `audit_log` is a single global chain, so with many case workflows appending
 * concurrently (the whole point of this system), two unlocked callers could read the same
 * "last hash" and both insert chained to it, making `verifyAuditChain` report a break that
 * isn't tampering. The lock makes every append see a consistent tail.
 *
 * Idempotent on `(caseId, action)`: the case state machine fires each action at most once,
 * so a Temporal activity retry that lands here after its insert already committed (e.g. the
 * worker crashed before acking) finds the existing row and no-ops instead of double-appending.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ hash: string }> {
  return db.transaction(async (tx) => {
    // Bound the wait: a stalled lock holder must not back up every appendAudit caller across
    // all cases (single global chain lock) and exhaust the connection pool.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_log_chain'))`);

    if (entry.caseId) {
      const [existing] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .where(and(eq(auditLog.caseId, entry.caseId), eq(auditLog.action, entry.action)))
        .limit(1);
      if (existing) return { hash: existing.hash };
    }

    const [last] = await tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const detail = entry.detail ?? {};
    const hash = hashEntry(prevHash, { actor: entry.actor, action: entry.action, detail, caseId: entry.caseId });
    await tx.insert(auditLog).values({ caseId: entry.caseId, actor: entry.actor, action: entry.action, detail, prevHash, hash });
    return { hash };
  });
}

/** Recompute the chain from genesis and report the first broken link, if any. */
export async function verifyAuditChain(db: Db): Promise<{ ok: boolean; brokenAtId?: number }> {
  const rows = await db.select().from(auditLog).orderBy(auditLog.id);
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    const expected = hashEntry(prevHash, {
      actor: row.actor,
      action: row.action,
      detail: row.detail,
      caseId: row.caseId ?? undefined,
    });
    if (row.prevHash !== prevHash || row.hash !== expected) {
      return { ok: false, brokenAtId: row.id };
    }
    prevHash = row.hash;
  }
  return { ok: true };
}
