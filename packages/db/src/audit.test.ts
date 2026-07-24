import { describe, expect, it } from "vitest";
import { buildTimestampRequest } from "./anchors.js";
import { computeAuditHash, GENESIS_HASH, verifyChainRows, type VerifiableRow } from "./audit.js";

/**
 * Pure audit-chain verification tests (PHASE6 §6.2). No live Postgres: chains are built with
 * the same `computeAuditHash` the writer uses, then fed to `verifyChainRows`. Tampering is
 * simulated by mutating a field WITHOUT recomputing its hash — exactly what a DB-level edit
 * does — and the verifier must name the row it breaks at.
 */

const KEY = "test-hmac-key";

interface EntryFields {
  caseId?: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
  /** v2-hashed fields; defaulted so most tests need not spell them out. */
  ts?: string;
  runId?: string;
  eventKey?: string;
}

const TS = "2026-07-24T00:00:00.000Z";

/** Build a valid chain of rows under the given per-row schemes. */
function buildChain(entries: (EntryFields & { scheme: "v1" | "v2" })[], hmacKey?: string): VerifiableRow[] {
  const rows: VerifiableRow[] = [];
  let prevHash = GENESIS_HASH;
  entries.forEach((e, i) => {
    const ts = e.ts ?? TS;
    const runId = e.runId ?? "run-1";
    const eventKey = e.eventKey ?? e.action;
    const hash = computeAuditHash(
      e.scheme,
      prevHash,
      { ...e, ts, runId, eventKey },
      e.scheme === "v2" ? hmacKey : undefined,
    );
    rows.push({
      id: i + 1,
      caseId: e.caseId ?? null,
      actor: e.actor,
      action: e.action,
      detail: e.detail,
      prevHash,
      hash,
      scheme: e.scheme,
      ts,
      runId,
      eventKey,
    });
    prevHash = hash;
  });
  return rows;
}

const sample = (scheme: "v1" | "v2"): (EntryFields & { scheme: "v1" | "v2" })[] => [
  { scheme, caseId: "c1", actor: "system", action: "case.detected", detail: { key: "heparin" } },
  { scheme, caseId: "c1", actor: "pharmacist-1", action: "review.approve", detail: { note: "ok" } },
  { scheme, caseId: "c1", actor: "system", action: "comms.sent", detail: { channels: 2 } },
];

describe("verifyChainRows", () => {
  it("accepts a good all-v1 chain", () => {
    expect(verifyChainRows(buildChain(sample("v1")))).toEqual({ ok: true });
  });

  it("accepts a good all-v2 chain when the key is supplied", () => {
    const rows = buildChain(sample("v2"), KEY);
    expect(verifyChainRows(rows, KEY)).toEqual({ ok: true });
  });

  it("accepts a chain across the v1 → v2 boundary", () => {
    const rows = buildChain(
      [
        { scheme: "v1", caseId: "c1", actor: "system", action: "case.detected", detail: {} },
        { scheme: "v1", caseId: "c1", actor: "system", action: "case.assessing", detail: {} },
        { scheme: "v2", caseId: "c1", actor: "system", action: "case.researching", detail: {} },
        { scheme: "v2", caseId: "c1", actor: "system", action: "comms.sent", detail: {} },
      ],
      KEY,
    );
    expect(verifyChainRows(rows, KEY)).toEqual({ ok: true });
  });

  it("fails a v2 chain when the key is absent (missing-hmac-key at the first v2 row)", () => {
    const rows = buildChain(sample("v2"), KEY);
    const result = verifyChainRows(rows); // no key
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing-hmac-key");
    expect(result.brokenAtId).toBe(1);
  });

  it("rejects an unrecognized scheme instead of coercing it to v1 (unknown-scheme)", () => {
    const rows = buildChain(sample("v1"));
    rows[1]!.scheme = "v9";
    const result = verifyChainRows(rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(2);
    expect(result.reason).toBe("unknown-scheme");
  });

  it("names the row when `detail` is tampered", () => {
    const rows = buildChain(sample("v1"));
    rows[1]!.detail = { note: "tampered" };
    const result = verifyChainRows(rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(2);
    expect(result.reason).toBe("hash-mismatch");
  });

  it("names the row when `actor` is tampered", () => {
    const rows = buildChain(sample("v1"));
    rows[0]!.actor = "attacker";
    const result = verifyChainRows(rows);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(1);
  });

  it("names the row when `caseId` is tampered", () => {
    const rows = buildChain(sample("v2"), KEY);
    rows[2]!.caseId = "c2";
    const result = verifyChainRows(rows, KEY);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(3);
  });

  it("accepts a v1 prefix followed by v2 rows (HMAC turned on mid-history)", () => {
    const rows = buildChain(
      [
        { scheme: "v1", caseId: "c1", actor: "system", action: "case.detected", detail: {} },
        { scheme: "v1", caseId: "c1", actor: "system", action: "case.assessing", detail: {} },
        { scheme: "v2", caseId: "c1", actor: "system", action: "comms.sent", detail: {} },
      ],
      KEY,
    );
    expect(verifyChainRows(rows, KEY)).toEqual({ ok: true });
  });

  it("rejects a scheme downgrade: a v1 row after a v2 row, even with a re-chained valid tail", () => {
    // The `scheme` column is DB-controlled. An attacker tampers a v2 row, relabels it v1,
    // recomputes its hash with keyless SHA-256, and re-chains the tail — with monotonic-scheme
    // enforcement this must still fail (otherwise verification would pass with no key at all).
    const rows = buildChain(sample("v2"), KEY); // ids 1,2,3 all v2
    const victim = rows[1]!;
    victim.scheme = "v1";
    victim.hash = computeAuditHash("v1", victim.prevHash, {
      caseId: victim.caseId ?? undefined,
      actor: victim.actor,
      action: victim.action,
      detail: victim.detail,
    });
    // Re-chain the tail so the ONLY remaining tell is the scheme downgrade itself.
    const tail = rows[2]!;
    tail.prevHash = victim.hash;
    tail.hash = computeAuditHash(
      "v2",
      tail.prevHash,
      { caseId: tail.caseId ?? undefined, actor: tail.actor, action: tail.action, detail: tail.detail },
      KEY,
    );
    const result = verifyChainRows(rows, KEY);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("scheme-downgrade");
    expect(result.brokenAtId).toBe(2);
  });

  it("detects a v2 row that was recomputed under the WRONG key", () => {
    const rows = buildChain(sample("v2"), KEY);
    // Attacker with DB write access rewrites row 2's hash under a key they guessed.
    const r = rows[1]!;
    r.hash = computeAuditHash(
      "v2",
      r.prevHash,
      { caseId: r.caseId ?? undefined, actor: r.actor, action: r.action, detail: r.detail },
      "wrong-key",
    );
    const result = verifyChainRows(rows, KEY);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(2);
  });

  it("fails a v2 row whose `ts` was backdated (ts is inside the HMAC payload)", () => {
    const rows = buildChain(sample("v2"), KEY);
    rows[1]!.ts = "2000-01-01T00:00:00.000Z"; // backdate without recomputing the hash
    const result = verifyChainRows(rows, KEY);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBe(2);
    expect(result.reason).toBe("hash-mismatch");
  });

  it("still verifies a v1 chain after ts/runId/eventKey change (v1 omits them by design)", () => {
    const rows = buildChain(sample("v1"));
    rows[1]!.ts = "1999-01-01T00:00:00.000Z";
    rows[1]!.runId = "different-run";
    rows[1]!.eventKey = "different-key";
    // These fields are not in the v1 payload, so the chain is byte-identical and still verifies.
    // (That backdate-ability is precisely the v1 weakness v2 closes.)
    expect(verifyChainRows(rows)).toEqual({ ok: true });
  });
});

describe("hashed payload is stable (PHASE6 §6.1 audit-chain-unchanged guarantee)", () => {
  // The RBAC migration adds `actor_user_id` (and the protocol author/approver FKs) but must NOT
  // change what the chain hashes — `actor` (text) stays the hashed identity, `actorUserId` is
  // persisted separately and never enters `computeAuditHash`. This golden hash pins the v1
  // payload bytes: if anyone widens the v1 hashed fields, this fails loudly. (The value is the
  // SHA-256 of the canonical {action,actor,caseId,detail} over the genesis prev-hash.)
  it("v1 hash of a known entry is byte-stable", () => {
    const hash = computeAuditHash("v1", GENESIS_HASH, {
      caseId: "c1",
      actor: "system",
      action: "case.detected",
      detail: { key: "heparin" },
    });
    expect(hash).toBe("60965ae0cf4816456840a1e06bad15b7e59d0375e0816bd72d0e4e6f5180eec4");
  });

  it("computeAuditHash has no actor-user-id input — the FK cannot affect the hash", () => {
    // The verifier's row shape (`VerifiableRow`) carries the hashed fields only; there is no
    // `actorUserId` on it, so a chain verifies identically whether or not the FK is populated.
    const base: VerifiableRow[] = [
      {
        id: 1,
        caseId: "c1",
        actor: "system",
        action: "case.detected",
        detail: {},
        prevHash: GENESIS_HASH,
        hash: computeAuditHash("v1", GENESIS_HASH, { caseId: "c1", actor: "system", action: "case.detected", detail: {} }),
        scheme: "v1",
        ts: TS,
        runId: "run-1",
        eventKey: "case.detected",
      },
    ];
    expect(verifyChainRows(base)).toEqual({ ok: true });
  });
});

describe("buildTimestampRequest", () => {
  const digestHex = "01".repeat(32);

  it("encodes a DER TimeStampReq with the SHA-256 imprint", () => {
    const der = buildTimestampRequest(digestHex);
    // Outer SEQUENCE, content length 57.
    expect(der.length).toBe(59);
    expect(der[0]).toBe(0x30);
    expect(der[1]).toBe(0x39);
    // version INTEGER 1.
    expect([...der.subarray(2, 5)]).toEqual([0x02, 0x01, 0x01]);
    // messageImprint SEQUENCE (len 49).
    expect([...der.subarray(5, 7)]).toEqual([0x30, 0x31]);
    // AlgorithmIdentifier SEQUENCE { sha256 OID, NULL }.
    expect([...der.subarray(7, 22)]).toEqual([
      0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00,
    ]);
    // hashedMessage OCTET STRING (32 bytes) == the digest.
    expect([...der.subarray(22, 24)]).toEqual([0x04, 0x20]);
    expect(der.subarray(24, 56).equals(Buffer.from(digestHex, "hex"))).toBe(true);
    // certReq BOOLEAN TRUE.
    expect([...der.subarray(56, 59)]).toEqual([0x01, 0x01, 0xff]);
  });

  it("rejects a digest that is not 32 bytes", () => {
    expect(() => buildTimestampRequest("00")).toThrow(/32-byte/);
  });
});
