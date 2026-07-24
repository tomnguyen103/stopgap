import { createHash, createHmac } from "node:crypto";
import { getEnv } from "@stopgap/core/env";
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

/** Hashing scheme of a row: `v1` bare SHA-256, `v2` keyed HMAC-SHA-256 (PHASE6 §6.2). */
export type AuditScheme = "v1" | "v2";

export interface AuditEntry {
  caseId?: string;
  actor: string;
  action: string;
  detail?: Record<string, unknown>;
  /**
   * The workflow run this entry belongs to. Part of the idempotency key, because a drug that
   * goes short again opens a NEW case run against the SAME case row — without this, the
   * second run's `case.researching` would collide with the first run's and the activity
   * would retry forever against a constraint it can never satisfy.
   */
  runId?: string;
  /**
   * Distinguishes repeats of the same `action` within one run. The monitoring loop appends
   * `case.monitoring` once a week; keyed on `action` alone, every tick after the first would
   * be swallowed by the idempotency check below and the case would look frozen at week 1.
   * Defaults to `action`.
   */
  eventKey?: string;
}

/** The subset of a row that is actually hashed. */
interface HashablePayload {
  caseId?: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  /** v2-only: hashed under HMAC so `ts` cannot be backdated. Ignored by v1. */
  ts?: string;
  /** v2-only: hashed so the idempotency metadata cannot be rewritten. Ignored by v1. */
  runId?: string;
  /** v2-only: hashed so the idempotency metadata cannot be rewritten. Ignored by v1. */
  eventKey?: string;
}

/**
 * Recompute a single row's hash under its scheme.
 *
 * `v1` hashes `{caseId,actor,action,detail}` with bare SHA-256 — byte-identical to the
 * pre-PHASE6 chain so rows written before HMAC existed still verify. It deliberately omits
 * `ts`/`runId`/`eventKey`; that is a known weakness of `v1` (a DB-write attacker could
 * backdate `ts`), which is exactly why `v2` exists and must not be weakened to match `v1`.
 *
 * `v2` HMACs a WIDER payload under `AUDIT_HMAC_KEY` — the same fields PLUS `ts`, `runId`, and
 * `eventKey` — so an attacker with only DB write access can neither recompute a valid hash
 * (the key is not in the database) NOR silently backdate the timestamp or rewrite the
 * idempotency metadata of a keyed row (CWE-354).
 *
 * Exported so tests (and any external verifier) can construct a known-good chain without a
 * live database; the byte layout is part of the audit contract.
 */
export function computeAuditHash(
  scheme: AuditScheme,
  prevHash: string,
  e: HashablePayload,
  hmacKey?: string,
): string {
  if (scheme === "v2") {
    if (!hmacKey) throw new Error("computeAuditHash: v2 scheme requires an HMAC key");
    const payload = canonical({
      caseId: e.caseId ?? null,
      actor: e.actor,
      action: e.action,
      detail: e.detail,
      ts: e.ts ?? null,
      runId: e.runId ?? null,
      eventKey: e.eventKey ?? null,
    });
    return createHmac("sha256", hmacKey).update(prevHash).update(payload).digest("hex");
  }
  // v1: keep the original narrow payload byte-for-byte.
  const payload = canonical({ caseId: e.caseId ?? null, actor: e.actor, action: e.action, detail: e.detail });
  return createHash("sha256").update(prevHash).update(payload).digest("hex");
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
 * Idempotent on `(caseId, action, runId)`: within one workflow run the case state machine
 * fires each action at most once, so a Temporal activity retry that lands here after its
 * insert already committed (e.g. the worker crashed before acking) finds the existing row and
 * no-ops instead of double-appending. A later run for the same drug is a different runId and
 * appends its own entries.
 *
 * The scheme is chosen from the environment: `AUDIT_HMAC_KEY` present → `v2` (keyed), absent
 * → `v1` (bare). A deployment that turns the key on writes `v2` from then on while its old
 * `v1` rows keep verifying — honest non-configuration, never a silent downgrade.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ hash: string }> {
  const hmacKey = getEnv().AUDIT_HMAC_KEY;
  const scheme: AuditScheme = hmacKey ? "v2" : "v1";
  return db.transaction(async (tx) => {
    // Bound the wait: a stalled lock holder must not back up every appendAudit caller across
    // all cases (single global chain lock) and exhaust the connection pool.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_log_chain'))`);

    if (entry.caseId) {
      const [existing] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.caseId, entry.caseId),
            eq(auditLog.eventKey, entry.eventKey ?? entry.action),
            eq(auditLog.runId, entry.runId ?? ""),
          ),
        )
        .limit(1);
      if (existing) return { hash: existing.hash };
    }

    const [last] = await tx.select({ hash: auditLog.hash }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    const prevHash = last?.hash ?? GENESIS_HASH;
    const detail = entry.detail ?? {};
    const runId = entry.runId ?? "";
    const eventKey = entry.eventKey ?? entry.action;
    // Set `ts` explicitly (not the column default) so the value we HASH for a v2 row is the
    // exact value we PERSIST — otherwise re-verification would recompute against a different
    // timestamp and every keyed row would fail.
    const ts = new Date();
    const hash = computeAuditHash(
      scheme,
      prevHash,
      { actor: entry.actor, action: entry.action, detail, caseId: entry.caseId, ts: ts.toISOString(), runId, eventKey },
      hmacKey,
    );
    await tx.insert(auditLog).values({
      caseId: entry.caseId,
      actor: entry.actor,
      action: entry.action,
      detail,
      ts,
      prevHash,
      hash,
      runId,
      eventKey,
      scheme,
    });
    return { hash };
  });
}

/** One row as `verifyChainRows` needs it — the hashed fields plus id/scheme. */
export interface VerifiableRow {
  id: number;
  caseId: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
  scheme: string;
  /** Hashed for v2 rows; `Date` (from the DB) or ISO string (from a test). Ignored for v1. */
  ts: Date | string;
  /** Hashed for v2 rows. Ignored for v1. */
  runId: string;
  /** Hashed for v2 rows. Ignored for v1. */
  eventKey: string;
}

/** Normalize a timestamp to the ISO string the writer hashed. */
function tsToIso(ts: Date | string): string {
  return typeof ts === "string" ? ts : ts.toISOString();
}

export interface ChainVerification {
  ok: boolean;
  /** Id of the first row whose link fails, if any. */
  brokenAtId?: number;
  /** Why it failed. */
  reason?: "prev-hash-mismatch" | "hash-mismatch" | "missing-hmac-key" | "scheme-downgrade";
}

/**
 * Pure chain verifier: recompute every row from genesis and report the first broken link.
 * Takes the rows (sorted by id) and the HMAC key rather than a database handle, so it is
 * unit-testable without Postgres and reusable by the CLI, the console, and the anchor check.
 *
 * A `v2` row with no key available FAILS at that row (`missing-hmac-key`) rather than being
 * skipped — that is what makes "recomputing the chain without AUDIT_HMAC_KEY cannot produce
 * valid rows" (§6.2 acceptance) true: an attacker who drops the key cannot make verification
 * pass by pretending the keyed rows are plain SHA-256.
 *
 * The `scheme` column is DB-controlled, so it cannot be trusted on its own: an attacker with
 * write access could tamper a `v2` row, relabel it `v1`, recompute its hash with keyless
 * SHA-256, and re-chain the tail — verification would pass with no key at all. We close that
 * by enforcing a MONOTONIC scheme: the chain may open with a `v1` prefix (rows written before
 * HMAC was enabled, which must still verify), but once any `v2` row appears every later row
 * must be `v2`. A `v1` row after the boundary is a downgrade attack → `scheme-downgrade`.
 */
export function verifyChainRows(rows: VerifiableRow[], hmacKey?: string): ChainVerification {
  let prevHash = GENESIS_HASH;
  let seenV2 = false;
  for (const row of rows) {
    const scheme: AuditScheme = row.scheme === "v2" ? "v2" : "v1";
    if (scheme === "v1" && seenV2) {
      return { ok: false, brokenAtId: row.id, reason: "scheme-downgrade" };
    }
    if (scheme === "v2") seenV2 = true;
    if (scheme === "v2" && !hmacKey) {
      return { ok: false, brokenAtId: row.id, reason: "missing-hmac-key" };
    }
    if (row.prevHash !== prevHash) {
      return { ok: false, brokenAtId: row.id, reason: "prev-hash-mismatch" };
    }
    const expected = computeAuditHash(
      scheme,
      prevHash,
      {
        caseId: row.caseId ?? undefined,
        actor: row.actor,
        action: row.action,
        detail: row.detail,
        ts: tsToIso(row.ts),
        runId: row.runId,
        eventKey: row.eventKey,
      },
      hmacKey,
    );
    if (row.hash !== expected) {
      return { ok: false, brokenAtId: row.id, reason: "hash-mismatch" };
    }
    prevHash = row.hash;
  }
  return { ok: true };
}

/** Recompute the chain from genesis and report the first broken link, if any. */
export async function verifyAuditChain(db: Db): Promise<ChainVerification> {
  const rows = await db
    .select({
      id: auditLog.id,
      caseId: auditLog.caseId,
      actor: auditLog.actor,
      action: auditLog.action,
      detail: auditLog.detail,
      prevHash: auditLog.prevHash,
      hash: auditLog.hash,
      scheme: auditLog.scheme,
      ts: auditLog.ts,
      runId: auditLog.runId,
      eventKey: auditLog.eventKey,
    })
    .from(auditLog)
    .orderBy(auditLog.id);
  return verifyChainRows(rows, getEnv().AUDIT_HMAC_KEY);
}
