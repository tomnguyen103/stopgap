import { createHash, createHmac } from "node:crypto";
import { getEnv } from "@stopgap/core/env";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client.js";
import { auditLog } from "./schema.js";

/** Deterministic JSON: object keys sorted recursively so hashing is stable. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

/** Genesis hash for an empty chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Hashing scheme of a row. Three byte-stable, append-only versions (PHASE6 §6.2, §6.1):
 *  - `v1` bare SHA-256 over the narrow `{caseId,actor,action,detail}` payload (the pre-PHASE6
 *    chain; attribution and metadata unhashed);
 *  - `v2` keyed HMAC-SHA-256 over that PLUS `ts`, `runId`, `eventKey` (PR A — closes backdating
 *    and idempotency-metadata rewrites);
 *  - `v3` the `v2` field set PLUS the nullable `actorUserId` FK (PR B — binds the authenticated
 *    principal so it cannot be silently reattributed, CWE-353);
 *  - `v4` the `v3` field set PLUS `orgId` (PHASE6 §6.5 — binds the TENANT, so a row cannot be
 *    relabelled into another hospital's chain without breaking its hash).
 * Each version's byte layout is FROZEN: a new field means a new scheme, never a mutation of an
 * existing one, so already-written rows keep verifying. `v2`, `v3` and `v4` all require the key.
 */
export type AuditScheme = "v1" | "v2" | "v3" | "v4";

export interface AuditEntry {
  /**
   * The tenant this entry belongs to (PHASE6 §6.5). Required, never inferred: the chain is
   * per-org, so an entry with the wrong org would be appended to — and would break — a different
   * hospital's chain. Hashed under `v4`.
   */
  orgId: string;
  caseId?: string;
  actor: string;
  /**
   * The authenticated principal (PHASE6 §6.1), a real `users.id`. Persisted to the
   * `actor_user_id` FK on every row; HASHED only under `v3` (keyed), so a keyed deployment binds
   * the identity into the HMAC while `v1`/`v2` rows keep it as unhashed provenance beside the
   * text `actor`. Optional: workflow-internal (`system`/`agent`) appends resolve it from the
   * synthetic users; a legacy caller may omit it entirely.
   */
  actorUserId?: string;
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
  /**
   * The owning tenant (PHASE6 §6.5). Hashed ONLY under `v4`. `v1`–`v3` byte layouts are frozen,
   * so their rows keep the org as unhashed provenance — which is exactly why the backfill of
   * historical rows into the seed org does not invalidate a single existing hash.
   */
  orgId?: string;
  caseId?: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  /** Hashed under `v2`/`v3` so `ts` cannot be backdated. Ignored by v1. */
  ts?: string;
  /** Hashed under `v2`/`v3` so the idempotency metadata cannot be rewritten. Ignored by v1. */
  runId?: string;
  /** Hashed under `v2`/`v3` so the idempotency metadata cannot be rewritten. Ignored by v1. */
  eventKey?: string;
  /**
   * The authenticated principal FK (PHASE6 §6.1). Hashed ONLY under `v3` — folded into the HMAC
   * so a DB writer cannot rewrite the recorded identity while keeping the chain valid (CWE-353).
   * Ignored by `v1` and `v2`, whose byte layouts are frozen; those keep it as unhashed provenance.
   */
  actorUserId?: string;
}

/**
 * Recompute a single row's hash under its scheme.
 *
 * `v1` hashes `{caseId,actor,action,detail}` with bare SHA-256 — byte-identical to the
 * pre-PHASE6 chain so rows written before HMAC existed still verify. It deliberately omits
 * `ts`/`runId`/`eventKey`; that is a known weakness of `v1` (a DB-write attacker could
 * backdate `ts`), which is exactly why `v2`/`v3` exist and must not be weakened to match `v1`.
 *
 * `v2` HMACs a WIDER payload under `AUDIT_HMAC_KEY` — the same fields PLUS `ts`, `runId`, and
 * `eventKey` — so an attacker with only DB write access can neither recompute a valid hash (the
 * key is not in the database) NOR silently backdate the timestamp or rewrite the idempotency
 * metadata of a keyed row (CWE-354). Its byte layout is FROZEN (PR A shipped it); `actorUserId`
 * is NOT in it.
 *
 * `v3` HMACs the `v2` field set PLUS the nullable `actorUserId`, binding the authenticated
 * principal so it cannot be reattributed without breaking the hash (CWE-353). `v2` rows written
 * before it stay verifiable because `v2`'s bytes are unchanged — a new field earns a new scheme,
 * never a mutation of an existing one.
 *
 * `v4` HMACs the `v3` field set PLUS `orgId` (PHASE6 §6.5). Without it, a DB writer could move a
 * row from one hospital's chain into another's by editing a single column, and nothing in the
 * hash would notice. New keyed rows are written as `v4`; `v1`–`v3` rows keep verifying byte-for-
 * byte, which is what allows migration 0013 to backfill every historical row into the seed org
 * without touching a single hash.
 *
 * Exported so tests (and any external verifier) can construct a known-good chain without a
 * live database; each version's byte layout is part of the audit contract.
 */
export function computeAuditHash(
  scheme: AuditScheme,
  prevHash: string,
  e: HashablePayload,
  hmacKey?: string,
): string {
  if (scheme === "v2" || scheme === "v3" || scheme === "v4") {
    if (!hmacKey) throw new Error(`computeAuditHash: ${scheme} scheme requires an HMAC key`);
    const payload = canonical({
      // Bind the scheme literal into the keyed payload so relabeling a keyed row to any other
      // scheme also breaks its hash (hash-mismatch), on top of the monotonic-rank check in
      // `verifyChainRows` — defence in depth against a DB writer editing `scheme`.
      scheme,
      caseId: e.caseId ?? null,
      actor: e.actor,
      action: e.action,
      detail: e.detail,
      ts: e.ts ?? null,
      runId: e.runId ?? null,
      eventKey: e.eventKey ?? null,
      // v3 additionally binds the authenticated principal FK; v2 stays byte-stable without it.
      // v4 binds the principal AND the tenant. Spelled as two separate spreads rather than one
      // `scheme >= v3` comparison so each version's exact field set is readable at a glance —
      // these literals ARE the audit contract, and a clever predicate here would make a future
      // scheme's addition silently change an older scheme's bytes.
      ...(scheme === "v3" || scheme === "v4" ? { actorUserId: e.actorUserId ?? null } : {}),
      ...(scheme === "v4" ? { orgId: e.orgId ?? null } : {}),
    });
    return createHmac("sha256", hmacKey).update(prevHash).update(payload).digest("hex");
  }
  // v1: keep the original narrow payload byte-for-byte.
  const payload = canonical({
    caseId: e.caseId ?? null,
    actor: e.actor,
    action: e.action,
    detail: e.detail,
  });
  return createHash("sha256").update(prevHash).update(payload).digest("hex");
}

/**
 * Append a hash-chained audit entry. Links to the previous row's hash so any later
 * tampering is detectable (see `verifyAuditChain`).
 *
 * The whole read-then-insert sequence runs inside a transaction serialized by a Postgres
 * advisory lock: within one org `audit_log` is a single chain, so with many case workflows
 * appending concurrently (the whole point of this system), two unlocked callers could read the
 * same "last hash" and both insert chained to it, making `verifyAuditChain` report a break that
 * isn't tampering. The lock makes every append see a consistent tail.
 *
 * The lock is KEYED PER ORG (PHASE6 §6.5), because the chain is now per-org: each tenant reads
 * its own tail, so two hospitals' appends are not in conflict and must not queue behind each
 * other. A single global lock would make every org's write latency a function of every other
 * org's write volume — the tenant-count-shaped scalability bug that multi-tenancy exists to
 * avoid — while buying nothing, since the rows they contend over are disjoint.
 *
 * Idempotent on `(caseId, action, runId)`: within one workflow run the case state machine
 * fires each action at most once, so a Temporal activity retry that lands here after its
 * insert already committed (e.g. the worker crashed before acking) finds the existing row and
 * no-ops instead of double-appending. A later run for the same drug is a different runId and
 * appends its own entries.
 *
 * The scheme is chosen from the environment: `AUDIT_HMAC_KEY` present → `v4` (keyed, binds the
 * authenticated principal AND the tenant), absent → `v1` (bare). A deployment that turns the key
 * on writes `v4` from then on while its old `v1` (and any legacy `v2`/`v3`) rows keep verifying —
 * honest non-configuration, never a silent downgrade.
 */
export async function appendAudit(db: Db, entry: AuditEntry): Promise<{ hash: string }> {
  const hmacKey = getEnv().AUDIT_HMAC_KEY;
  const scheme: AuditScheme = hmacKey ? "v4" : "v1";
  return db.transaction(async (tx) => {
    // Bound the wait: a stalled lock holder must not back up every appendAudit caller in this
    // org and exhaust the connection pool.
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('audit_log_chain:' || ${entry.orgId}))`,
    );

    if (entry.caseId) {
      const [existing] = await tx
        .select({ hash: auditLog.hash })
        .from(auditLog)
        .where(
          and(
            // The org filter is explicit even though RLS would already hide another tenant's row:
            // an idempotency check that silently matched across tenants would return a FOREIGN
            // row's hash to this caller, which is worse than a duplicate append.
            eq(auditLog.orgId, entry.orgId),
            eq(auditLog.caseId, entry.caseId),
            eq(auditLog.eventKey, entry.eventKey ?? entry.action),
            eq(auditLog.runId, entry.runId ?? ""),
          ),
        )
        .limit(1);
      if (existing) return { hash: existing.hash };
    }

    // THIS ORG's tail, not the deployment's: each tenant's chain runs from its own genesis, so a
    // new org's first entry chains to GENESIS_HASH rather than to whatever another hospital
    // happened to write last.
    const [last] = await tx
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .where(eq(auditLog.orgId, entry.orgId))
      .orderBy(desc(auditLog.id))
      .limit(1);
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
      {
        actor: entry.actor,
        action: entry.action,
        detail,
        caseId: entry.caseId,
        ts: ts.toISOString(),
        runId,
        eventKey,
        // v3/v4 bind the principal FK into the HMAC (CWE-353); v1 ignores it.
        actorUserId: entry.actorUserId,
        // v4 additionally binds the tenant; v1-v3 ignore it.
        orgId: entry.orgId,
      },
      hmacKey,
    );
    await tx.insert(auditLog).values({
      orgId: entry.orgId,
      caseId: entry.caseId,
      actor: entry.actor,
      // Persisted, AND bound into the hash for `v3`/`v4` rows (see the `computeAuditHash` call
      // above, which is passed this exact value): a keyed deployment cannot have the recorded
      // principal rewritten without breaking the chain (CWE-353). On a `v1`/`v2` row it is unhashed
      // provenance riding alongside the hashed text `actor` — those byte layouts are frozen.
      actorUserId: entry.actorUserId,
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
  /**
   * The owning tenant. Hashed for `v4` rows ONLY (PHASE6 §6.5); ignored by `v1`–`v3`, whose bytes
   * are frozen. Optional so a caller verifying a pre-multi-tenancy chain (or a test building one)
   * need not invent a value for a field those schemes never look at.
   */
  orgId?: string | null;
  caseId: string | null;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  prevHash: string;
  hash: string;
  scheme: string;
  /** Hashed for v2/v3 rows; `Date` (from the DB) or ISO string (from a test). Ignored for v1. */
  ts: Date | string;
  /** Hashed for v2/v3 rows. Ignored for v1. */
  runId: string;
  /** Hashed for v2/v3 rows. Ignored for v1. */
  eventKey: string;
  /** The authenticated principal FK. Hashed for v3 rows only (CWE-353); ignored for v1/v2. */
  actorUserId: string | null;
}

/** Monotonic rank of each scheme: a chain may never move to a LOWER-ranked scheme (downgrade). */
const SCHEME_RANK: Record<AuditScheme, number> = { v1: 1, v2: 2, v3: 3, v4: 4 };

/** Normalize a timestamp to the ISO string the writer hashed. */
function tsToIso(ts: Date | string): string {
  return typeof ts === "string" ? ts : ts.toISOString();
}

export interface ChainVerification {
  ok: boolean;
  /** Id of the first row whose link fails, if any. */
  brokenAtId?: number;
  /** Why it failed. */
  reason?:
    | "prev-hash-mismatch"
    | "hash-mismatch"
    | "missing-hmac-key"
    | "scheme-downgrade"
    | "unknown-scheme";
}

/**
 * Pure chain verifier: recompute every row from genesis and report the first broken link.
 * Takes the rows (sorted by id) and the HMAC key rather than a database handle, so it is
 * unit-testable without Postgres and reusable by the CLI, the console, and the anchor check.
 *
 * Verifies ONE ORG's rows (PHASE6 §6.5). The caller supplies a single tenant's chain, in id
 * order; each org's chain runs from `GENESIS_HASH` independently, so a brand-new org verifies
 * from its first row and a broken chain in org A says nothing about org B. Feeding it two orgs'
 * rows interleaved would report `prev-hash-mismatch` at the first crossover — a correct answer to
 * the wrong question, which is why `verifyAuditChain` never assembles such a list.
 *
 * A `v2`/`v3` row with no key available FAILS at that row (`missing-hmac-key`) rather than being
 * skipped — that is what makes "recomputing the chain without AUDIT_HMAC_KEY cannot produce
 * valid rows" (§6.2 acceptance) true: an attacker who drops the key cannot make verification
 * pass by pretending the keyed rows are plain SHA-256.
 *
 * The `scheme` column is DB-controlled, so it cannot be trusted on its own: an attacker with
 * write access could tamper a keyed row, relabel it to a weaker scheme, recompute its hash, and
 * re-chain the tail — verification could pass with no key at all. We close that by enforcing a
 * MONOTONIC scheme RANK (v1=1 < v2=2 < v3=3): the chain may climb (a `v1` prefix from before HMAC
 * was enabled, then `v2`, then `v3`), but a row whose rank is LOWER than the highest rank seen so
 * far is a downgrade attack → `scheme-downgrade`.
 */
export function verifyChainRows(rows: VerifiableRow[], hmacKey?: string): ChainVerification {
  let prevHash = GENESIS_HASH;
  let maxRank = 0;
  for (const row of rows) {
    // Reject an unrecognized scheme outright rather than silently coercing it to `v1`: a
    // DB writer must not be able to smuggle a tampered row past verification by stamping it
    // with a scheme the verifier does not know how to check.
    if (row.scheme !== "v1" && row.scheme !== "v2" && row.scheme !== "v3" && row.scheme !== "v4") {
      return { ok: false, brokenAtId: row.id, reason: "unknown-scheme" };
    }
    const scheme: AuditScheme = row.scheme;
    const rank = SCHEME_RANK[scheme];
    if (rank < maxRank) {
      return { ok: false, brokenAtId: row.id, reason: "scheme-downgrade" };
    }
    maxRank = rank;
    if (scheme !== "v1" && !hmacKey) {
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
        actorUserId: row.actorUserId ?? undefined,
        orgId: row.orgId ?? undefined,
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

/**
 * Recompute ONE ORG's chain from its genesis and report the first broken link, if any.
 *
 * `orgId` is an explicit argument rather than something inferred from the connection's
 * `app.current_org`: RLS would already hide other tenants' rows, but a verification that silently
 * depended on ambient state could report "chain OK" over an empty result set if the scope were
 * ever missing — a green integrity check that verified nothing. The explicit filter makes the
 * question the caller asked ("is org X's chain intact?") the question the query answers.
 */
export async function verifyAuditChain(db: Db, orgId: string): Promise<ChainVerification> {
  const rows = await db
    .select({
      id: auditLog.id,
      orgId: auditLog.orgId,
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
      actorUserId: auditLog.actorUserId,
    })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(auditLog.id);
  return verifyChainRows(rows, getEnv().AUDIT_HMAC_KEY);
}
