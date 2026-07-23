import { createHash } from "node:crypto";
import { desc } from "drizzle-orm";
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
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ hash: string }> {
  const [last] = await db.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
  const prevHash = last?.hash ?? GENESIS_HASH;
  const detail = entry.detail ?? {};
  const hash = hashEntry(prevHash, { actor: entry.actor, action: entry.action, detail, caseId: entry.caseId });
  await db.insert(auditLog).values({
    caseId: entry.caseId,
    actor: entry.actor,
    action: entry.action,
    detail,
    prevHash,
    hash,
  });
  return { hash };
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
