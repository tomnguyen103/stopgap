import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getEnv } from "@stopgap/core/env";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
import { SEED_ORG_ID } from "./orgs.js";
import { auditAnchors, auditLog, type AuditAnchorRow } from "./schema.js";

/**
 * External anchoring of the audit chain (PHASE6 §6.2). HMAC (see `audit.ts`) stops a
 * write-only attacker from forging rows; anchoring stops even a key holder from rewriting
 * history unnoticed, by pinning the chain head to a sink OUTSIDE the database — an append-only
 * file on a Docker volume, and optionally an RFC 3161 timestamp token from a third-party
 * authority. Nothing here fakes delivery: a missing/failing TSA is recorded as `sink: "file"`,
 * the same honest-non-configuration stance the comms layer takes.
 */

/** SHA-256 AlgorithmIdentifier body: OID 2.16.840.1.101.3.4.2.1. */
const SHA256_OID = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);

/** DER length octets (short form under 128, else long form). */
function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** DER tag-length-value. */
function derTlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/**
 * Build a minimal RFC 3161 `TimeStampReq` (DER) for a SHA-256 message imprint. Pure and
 * dependency-free so it can be unit-tested byte-for-byte; the network POST that submits it
 * lives in `anchorAuditChain` behind `AUDIT_TSA_URL` and is never exercised in tests.
 *
 *   TimeStampReq ::= SEQUENCE {
 *     version        INTEGER { v1(1) },
 *     messageImprint MessageImprint,   -- SEQUENCE { AlgorithmIdentifier, OCTET STRING }
 *     certReq        BOOLEAN            -- TRUE: ask the TSA to return its signing cert
 *   }
 */
export function buildTimestampRequest(sha256HexDigest: string): Buffer {
  const digest = Buffer.from(sha256HexDigest, "hex");
  if (digest.length !== 32) {
    throw new Error(
      `buildTimestampRequest: expected a 32-byte SHA-256 digest, got ${digest.length} bytes`,
    );
  }
  const version = derTlv(0x02, Buffer.from([0x01])); // INTEGER 1
  const algId = derTlv(0x30, Buffer.concat([SHA256_OID, derTlv(0x05, Buffer.alloc(0))])); // SEQ { OID, NULL }
  const hashedMessage = derTlv(0x04, digest); // OCTET STRING
  const messageImprint = derTlv(0x30, Buffer.concat([algId, hashedMessage]));
  const certReq = derTlv(0x01, Buffer.from([0xff])); // BOOLEAN TRUE
  return derTlv(0x30, Buffer.concat([version, messageImprint, certReq]));
}

/** Best-effort RFC 3161 timestamp. Returns the base64 token, or a non-delivery reason. */
async function requestTsaToken(
  tsaUrl: string,
  headHash: string,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  try {
    const req = buildTimestampRequest(headHash);
    const res = await fetch(tsaUrl, {
      method: "POST",
      headers: { "content-type": "application/timestamp-query" },
      // Copy into a plain Uint8Array: a Node Buffer's generic ArrayBuffer type is not
      // assignable to the DOM `BodyInit` the console's lib.dom typings resolve `fetch` against.
      body: new Uint8Array(req),
    });
    if (!res.ok) return { ok: false, error: `TSA responded ${res.status}` };
    const token = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { ok: true, token };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Anchor ONE org's chain head. No-op (returns `null`) when that org has no audit rows yet — there
 * is nothing to pin, and an anchor row claiming otherwise would be a fiction.
 *
 * PER-ORG SINCE PASS 2 (PHASE6 §6.5). Pass 1 made the chain per-tenant but left this function
 * anchoring `max(audit_log.id)` across the whole deployment, which is a real defect once more than
 * one org writes: "the head hash" stops being one value, the anchor pins whichever tenant appended
 * most recently, and `verifyAnchors` ends up comparing an anchor against a chain it does not
 * belong to. Each org is anchored separately so the pinned `(maxAuditId, headHash)` pair is
 * unambiguously a statement about that org's chain.
 */
async function anchorOneOrg(db: Db, orgId: string): Promise<AuditAnchorRow | null> {
  const [head] = await db
    .select({ id: auditLog.id, hash: auditLog.hash })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (!head) return null;

  const env = getEnv();
  const ts = new Date();
  // The line carries `orgId` from now on. Lines written BEFORE this change have no such field;
  // `readAnchorFile` maps those to the seed org rather than dropping them — see there.
  const line = JSON.stringify({
    ts: ts.toISOString(),
    orgId,
    maxAuditId: head.id,
    headHash: head.hash,
  });
  // The file anchor is the always-present sink. Create the parent dir on first write so a
  // fresh deployment (or a fresh Docker volume) does not fail the very first anchor.
  await mkdir(dirname(env.AUDIT_ANCHOR_FILE), { recursive: true });
  await appendFile(env.AUDIT_ANCHOR_FILE, `${line}\n`, "utf8");

  let sink = "file";
  let sinkRef: string = env.AUDIT_ANCHOR_FILE;
  if (env.AUDIT_TSA_URL) {
    const tsa = await requestTsaToken(env.AUDIT_TSA_URL, head.hash);
    if (tsa.ok) {
      sink = "tsa";
      sinkRef = tsa.token;
    } else {
      // Honest non-delivery: the file anchor stands, and we say so rather than inventing a
      // token. The failure reason rides along in sinkRef so it is auditable after the fact.
      sinkRef = `${env.AUDIT_ANCHOR_FILE} | tsa-error: ${tsa.error}`;
    }
  }

  const [row] = await db
    .insert(auditAnchors)
    .values({ orgId, ts, maxAuditId: head.id, headHash: head.hash, sink, sinkRef })
    .returning();
  return row ?? null;
}

/**
 * Take one anchor per organization. Returns the rows actually written — an org with an empty chain
 * contributes nothing, so an empty array is the honest answer for a fresh deployment rather than a
 * row pinning a head that does not exist.
 *
 * CROSS-TENANT BY DESIGN (PHASE6 §6.5). It reads every org's chain, so it must run through
 * `withBypassDb` under a role holding BYPASSRLS (`stopgap_maintenance`, see
 * `docs/multi-tenancy.md`). Run on an ordinary org-scoped connection, the per-org head queries
 * return nothing, every org no-ops, and tamper-evidence quietly stops accumulating — the
 * fail-closed direction, but SILENT, which is why the role requirement is not optional.
 *
 * `orgIds` is a parameter rather than a `select` from `organizations` inside this function so the
 * caller owns the enumeration (the activity already lists orgs for other work) and so a test can
 * anchor a known set without seeding the registry.
 */
export async function anchorAuditChain(
  db: Db,
  orgIds: readonly string[],
): Promise<AuditAnchorRow[]> {
  const rows: AuditAnchorRow[] = [];
  for (const orgId of orgIds) {
    // Sequential, not `Promise.all`: each iteration appends a line to ONE file, and concurrent
    // `appendFile` calls to the same path are not ordered against each other.
    const row = await anchorOneOrg(db, orgId);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * Most recent anchors first (verification UI + CLI). `orgId` narrows to one tenant's anchors; the
 * cross-tenant view (`pnpm verify-audit`) omits it and runs under the bypass role.
 */
export async function listAnchors(db: Db, limit = 50, orgId?: string): Promise<AuditAnchorRow[]> {
  return orgId === undefined
    ? db.select().from(auditAnchors).orderBy(desc(auditAnchors.id)).limit(limit)
    : db
        .select()
        .from(auditAnchors)
        .where(eq(auditAnchors.orgId, orgId))
        .orderBy(desc(auditAnchors.id))
        .limit(limit);
}

/**
 * The key an external anchor record is filed under: one tenant's chain at one audit id. A composite
 * string rather than a nested map because that is the whole of the lookup — `verifyAnchors` asks
 * "what did the outside world record for THIS org at THIS id" and nothing else. ` ` separates
 * the parts because a uuid can never contain it, so two different pairs can never collide into one
 * key.
 */
function anchorFileKey(orgId: string, maxAuditId: number): string {
  return `${orgId}:${String(maxAuditId)}`;
}

/**
 * Read the EXTERNAL anchor file into a `(orgId, maxAuditId) → headHash` map. This is the sink the
 * DB cannot reach, so it is the only anchor an attacker with DB write access cannot also patch.
 * Returns `null` (honest "no external record") when the file is missing or unreadable — never
 * throws, so verification degrades to DB-internal-only rather than crashing. The file is one JSON
 * object per line (`{ts,orgId,maxAuditId,headHash}`), appended hourly, so it stays small.
 *
 * BACKWARD COMPATIBILITY IS EXPLICIT, NOT ACCIDENTAL. Lines appended before PHASE6 §6.5 pass 2 have
 * no `orgId` field: at the time they were written the deployment had exactly one tenant, the one
 * migration 0013 backfilled everything into. Such a line is therefore attributed to `SEED_ORG_ID`,
 * which is not a guess — it is the only org those rows could have belonged to. The alternative
 * readings are both wrong: skipping the line would silently discard the strongest tamper evidence
 * the deployment has (the pre-existing external record), and throwing would turn "this file has
 * history in it" into a crash on the verification path. The choice is made here, once, and stated,
 * rather than left as a `?? something` at the comparison site.
 */
export async function readAnchorFile(): Promise<Map<string, string> | null> {
  try {
    const contents = await readFile(getEnv().AUDIT_ANCHOR_FILE, "utf8");
    const map = new Map<string, string>();
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as {
          orgId?: unknown;
          maxAuditId?: unknown;
          headHash?: unknown;
        };
        if (typeof parsed.maxAuditId === "number" && typeof parsed.headHash === "string") {
          const orgId = typeof parsed.orgId === "string" ? parsed.orgId : SEED_ORG_ID;
          // Later lines win for a repeated pair (append-only, so newest is last).
          map.set(anchorFileKey(orgId, parsed.maxAuditId), parsed.headHash);
        }
      } catch {
        // A single malformed line must not sink the whole external check.
      }
    }
    return map;
  } catch {
    return null;
  }
}

export interface AnchorVerification extends AuditAnchorRow {
  /**
   * DB-internal check: does row `maxAuditId`'s hash in the LIVE chain still equal the head
   * this anchor row pinned? Both sides live in the database, so an attacker who patches
   * `audit_anchors` too passes this — it is the weaker of the two checks.
   */
  headMatches: boolean;
  /**
   * EXTERNAL check: does the anchor file's recorded head for `maxAuditId` still equal the live
   * chain's hash there? The file is outside the DB, so a DB-write attacker cannot patch it —
   * a mismatch here is the strong, distinct failure. `null` = no external record for this id
   * (or the file is unreadable), which is honest, not a pass.
   */
  externalMatches: boolean | null;
}

/**
 * Cross-check stored anchors against BOTH the live chain (DB-internal) and the external anchor
 * file. `limit` defaults to "all" so the verification path never silently stops re-checking
 * older anchors; the display `listAnchors` keeps its small default. Batches the head lookups
 * into one query rather than one per anchor.
 *
 * PER ORG (PHASE6 §6.5 pass 2). Pass `orgId` to verify one tenant's anchors — what the console's
 * integrity page does, because a signed-in pharmacist is asking about THEIR hospital's history and
 * an answer mixing in another tenant's anchors would be both a leak and a non sequitur. Omit it
 * (the `pnpm verify-audit` path, under the bypass role) to check every org's.
 *
 * The live-hash lookup is scoped to the anchor's own org, not just its id. `audit_log.id` is a
 * deployment-wide sequence, so an id alone would resolve to a row regardless of tenant — and an
 * anchor whose `org_id` had been tampered to point at another hospital's row would then verify
 * green against a chain it was never taken over. Matching on `(org_id, id)` makes that edit a
 * mismatch instead.
 */
export async function verifyAnchors(
  db: Db,
  limit: number = Number.MAX_SAFE_INTEGER,
  orgId?: string,
): Promise<AnchorVerification[]> {
  const anchors = await listAnchors(db, limit, orgId);
  if (anchors.length === 0) return [];
  const ids = [...new Set(anchors.map((a) => a.maxAuditId))];
  const heads = await db
    .select({ id: auditLog.id, orgId: auditLog.orgId, hash: auditLog.hash })
    .from(auditLog)
    .where(
      orgId === undefined
        ? inArray(auditLog.id, ids)
        : and(eq(auditLog.orgId, orgId), inArray(auditLog.id, ids)),
    );
  const liveHashByOrgAndId = new Map(heads.map((h) => [anchorFileKey(h.orgId, h.id), h.hash]));
  const external = await readAnchorFile();
  return anchors.map((anchor) => {
    const lookupKey = anchorFileKey(anchor.orgId, anchor.maxAuditId);
    const liveHash = liveHashByOrgAndId.get(lookupKey);
    const externalHead = external?.get(lookupKey);
    return {
      ...anchor,
      // Missing row (truncated chain, or an anchor relabelled into another org) is a mismatch too:
      // the anchored head is simply not there under the org this row claims.
      headMatches: liveHash === anchor.headHash,
      // Compare the OUTSIDE-the-DB record against the live chain. null when we have no external
      // record for this org+id (file missing/unreadable, or this anchor predates the file).
      externalMatches:
        external === null || externalHead === undefined ? null : externalHead === liveHash,
    };
  });
}
