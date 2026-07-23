import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
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
 * Idempotent on `(caseId, action)`: the case state machine fires each action at most once,
 * so a Temporal activity retry that lands here after its insert already committed (e.g. the
 * worker crashed before acking) finds the unique-index conflict and no-ops instead of
 * double-appending and desyncing the hash chain.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ hash: string }> {
  if (entry.caseId) {
    const [existing] = await db
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(and(eq(auditLog.caseId, entry.caseId), eq(auditLog.action, entry.action)))
      .limit(1);
    if (existing) return { hash: existing.hash };
  }

  const [last] = await db.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  const detail = entry.detail ?? {};
  const hash = hashEntry(prevHash, { actor: entry.actor, action: entry.action, detail, caseId: entry.caseId });
  const [inserted] = await db
    .insert(auditLog)
    .values({ caseId: entry.caseId, actor: entry.actor, action: entry.action, detail, prevHash, hash })
    .onConflictDoNothing({ target: [auditLog.caseId, auditLog.action] })
    .returning({ hash: auditLog.hash });
  // Lost the race to a concurrent retry between the pre-check and this insert.
  if (inserted) return { hash: inserted.hash };
  const [raced] = await db
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .where(and(eq(auditLog.caseId, entry.caseId!), eq(auditLog.action, entry.action)))
    .limit(1);
  return { hash: raced!.hash };
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
