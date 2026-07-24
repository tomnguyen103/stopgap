import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getEnv } from "@stopgap/core/env";
import { desc, inArray } from "drizzle-orm";
import type { Db } from "./client.js";
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
    throw new Error(`buildTimestampRequest: expected a 32-byte SHA-256 digest, got ${digest.length} bytes`);
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
 * Take one anchor of the current chain head. No-op (returns `null`) on an empty chain — there
 * is nothing to pin yet. Always writes the file sink; if `AUDIT_TSA_URL` is set it also tries
 * for a signed timestamp token and records `sink: "tsa"` only when one actually came back.
 */
export async function anchorAuditChain(db: Db): Promise<AuditAnchorRow | null> {
  const [head] = await db
    .select({ id: auditLog.id, hash: auditLog.hash })
    .from(auditLog)
    .orderBy(desc(auditLog.id))
    .limit(1);
  if (!head) return null;

  const env = getEnv();
  const ts = new Date();
  const line = JSON.stringify({ ts: ts.toISOString(), maxAuditId: head.id, headHash: head.hash });
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
    .values({ ts, maxAuditId: head.id, headHash: head.hash, sink, sinkRef })
    .returning();
  return row ?? null;
}

/** Most recent anchors first (verification UI + CLI). */
export async function listAnchors(db: Db, limit = 50): Promise<AuditAnchorRow[]> {
  return db.select().from(auditAnchors).orderBy(desc(auditAnchors.id)).limit(limit);
}

/**
 * Read the EXTERNAL anchor file into a `maxAuditId → headHash` map. This is the sink the DB
 * cannot reach, so it is the only anchor an attacker with DB write access cannot also patch.
 * Returns `null` (honest "no external record") when the file is missing or unreadable — never
 * throws, so verification degrades to DB-internal-only rather than crashing. The file is one
 * JSON object per line (`{ts,maxAuditId,headHash}`), appended hourly, so it stays small.
 */
export async function readAnchorFile(): Promise<Map<number, string> | null> {
  try {
    const contents = await readFile(getEnv().AUDIT_ANCHOR_FILE, "utf8");
    const map = new Map<number, string>();
    for (const line of contents.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { maxAuditId?: unknown; headHash?: unknown };
        if (typeof parsed.maxAuditId === "number" && typeof parsed.headHash === "string") {
          // Later lines win for a repeated id (append-only, so newest is last).
          map.set(parsed.maxAuditId, parsed.headHash);
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
 */
export async function verifyAnchors(
  db: Db,
  limit: number = Number.MAX_SAFE_INTEGER,
): Promise<AnchorVerification[]> {
  const anchors = await listAnchors(db, limit);
  if (anchors.length === 0) return [];
  const ids = [...new Set(anchors.map((a) => a.maxAuditId))];
  const heads = await db
    .select({ id: auditLog.id, hash: auditLog.hash })
    .from(auditLog)
    .where(inArray(auditLog.id, ids));
  const liveHashById = new Map(heads.map((h) => [h.id, h.hash]));
  const external = await readAnchorFile();
  return anchors.map((anchor) => {
    const liveHash = liveHashById.get(anchor.maxAuditId);
    const externalHead = external?.get(anchor.maxAuditId);
    return {
      ...anchor,
      // Missing row (truncated chain) is a mismatch too — the anchored head is simply gone.
      headMatches: liveHash === anchor.headHash,
      // Compare the OUTSIDE-the-DB record against the live chain. null when we have no external
      // record for this id (file missing/unreadable, or this anchor predates the file).
      externalMatches: external === null || externalHead === undefined ? null : externalHead === liveHash,
    };
  });
}
