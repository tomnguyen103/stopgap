import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PER-ORG AUDIT ANCHORING (PHASE6 §6.5 pass 2), and its backward compatibility with anchor-file
 * lines written before the org existed.
 *
 * Pass 1 made the audit CHAIN per-tenant but left `audit_anchors` global, which made every anchor
 * ambiguous the moment a second org appeared: "the head hash" is no longer one value, so an anchor
 * pinned whichever tenant happened to append last and `verifyAnchors` could compare it against a
 * chain it did not belong to. Migration 0014 adds `org_id`; this file pins the behaviour that
 * change is supposed to buy.
 *
 * The file sink is REAL here (a temp directory), because the whole point of the external anchor is
 * that it lives outside the database — mocking it away would test everything except the property
 * under discussion.
 */

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000b1";
const SEED_ORG_ID = "00000000-0000-0000-0000-0000000000a1";

let anchorFile = "";
vi.mock("@stopgap/core/env", () => ({
  getEnv: () => ({ AUDIT_ANCHOR_FILE: anchorFile, AUDIT_TSA_URL: undefined }),
}));
vi.mock("./client.js", () => ({ getDb: () => ({}) }));

const { anchorAuditChain, readAnchorFile, verifyAnchors } = await import("./anchors.js");

/** Heads per org, as the DB would report them. */
const heads: Record<string, { id: number; hash: string } | undefined> = {};
/** Anchor rows, as `listAnchors` would return them (newest first). */
let anchorRows: Record<string, unknown>[] = [];
/** Every anchor row the fake insert received. */
let insertedAnchors: Record<string, unknown>[] = [];

/**
 * A fake drizzle handle covering exactly the three shapes `anchors.ts` uses: the per-org head
 * select, the anchor insert, and the `listAnchors` / live-hash selects inside `verifyAnchors`.
 * Dispatch is on which columns were requested, which is enough to keep the fake honest without
 * reimplementing a query planner.
 */
function fakeDb() {
  const select = (fields: Record<string, unknown>) => {
    const wanted = Object.keys(fields);
    let orgFilter: string | undefined;
    const self: Record<string, unknown> = {};
    self.from = () => self;
    self.where = (predicate: unknown) => {
      orgFilter = extractOrgId(predicate);
      return self;
    };
    self.orderBy = () => self;
    self.limit = () => resolve();
    self.then = (r: (v: unknown) => unknown) => Promise.resolve(resolve()).then(r);
    function resolve(): unknown[] {
      // Head lookup: {id, hash} for one org.
      if (wanted.length === 2 && wanted.includes("id") && wanted.includes("hash")) {
        const head = orgFilter ? heads[orgFilter] : undefined;
        return head ? [head] : [];
      }
      // Live-hash batch inside verifyAnchors: {id, orgId, hash}.
      if (wanted.includes("orgId") && wanted.includes("hash")) {
        return Object.entries(heads).flatMap(([orgId, head]) =>
          head ? [{ id: head.id, orgId, hash: head.hash }] : [],
        );
      }
      return [];
    }
    return self;
  };
  return {
    // `listAnchors` calls `db.select()` with no fields.
    select: (fields?: Record<string, unknown>) => {
      if (fields) return select(fields);
      let orgFilter: string | undefined;
      const self: Record<string, unknown> = {};
      self.from = () => self;
      self.where = (p: unknown) => {
        orgFilter = extractOrgId(p);
        return self;
      };
      self.orderBy = () => self;
      self.limit = () =>
        Promise.resolve(orgFilter ? anchorRows.filter((a) => a.orgId === orgFilter) : anchorRows);
      return self;
    },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedAnchors.push(v);
        return { returning: () => Promise.resolve([{ id: insertedAnchors.length, ...v }]) };
      },
    }),
  };
}

/**
 * Pull the uuid a predicate compares against, so the fake can answer per-org queries. Guarded by a
 * `seen` set: drizzle's SQL nodes hold back-references to their table, so an unguarded walk
 * recurses forever.
 */
function extractOrgId(node: unknown): string | undefined {
  const seen = new WeakSet<object>();
  let found: string | undefined;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    const values = Array.isArray(n) ? n : Object.values(n as Record<string, unknown>);
    for (const value of values) {
      if (
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ) {
        found = value;
        return;
      }
      if (value && typeof value === "object") walk(value);
      if (found) return;
    }
  };
  walk(node);
  return found;
}

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), "stopgap-anchors-"));
  anchorFile = join(dir, "anchors.jsonl");
  for (const k of Object.keys(heads)) delete heads[k];
  anchorRows = [];
  insertedAnchors = [];
});

describe("anchorAuditChain", () => {
  it("writes ONE anchor per org, each pinning that org's own chain head", async () => {
    heads[ORG_A] = { id: 42, hash: "a".repeat(64) };
    heads[ORG_B] = { id: 41, hash: "b".repeat(64) };
    const rows = await anchorAuditChain(fakeDb() as never, [ORG_A, ORG_B]);
    expect(rows).toHaveLength(2);
    expect(insertedAnchors.map((r) => [r.orgId, r.maxAuditId, r.headHash])).toEqual([
      [ORG_A, 42, "a".repeat(64)],
      [ORG_B, 41, "b".repeat(64)],
    ]);
    // Org B's head is a LOWER audit id than org A's. A deployment-wide `max(audit_log.id)` — the
    // pass-1 shape — would have pinned 42 for both, silently anchoring org A's hash as if it were
    // org B's.
  });

  it("skips an org with an empty chain rather than anchoring a head that does not exist", async () => {
    heads[ORG_A] = { id: 7, hash: "c".repeat(64) };
    const rows = await anchorAuditChain(fakeDb() as never, [ORG_A, ORG_B]);
    expect(rows).toHaveLength(1);
    expect(insertedAnchors).toHaveLength(1);
    expect(insertedAnchors[0]?.orgId).toBe(ORG_A);
  });

  it("writes the org into each external anchor-file line", async () => {
    heads[ORG_A] = { id: 5, hash: "d".repeat(64) };
    heads[ORG_B] = { id: 6, hash: "e".repeat(64) };
    await anchorAuditChain(fakeDb() as never, [ORG_A, ORG_B]);
    const lines = (await readFile(anchorFile, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l: { orgId: string }) => l.orgId)).toEqual([ORG_A, ORG_B]);
  });
});

describe("readAnchorFile — backward compatibility with pre-multi-tenancy lines", () => {
  it("attributes a line with NO orgId to the seed org rather than dropping or crashing on it", async () => {
    // Exactly what the hourly job appended before pass 2: no `orgId` field at all. At the time it
    // was written the deployment had one tenant — the org migration 0013 backfilled everything
    // into — so the attribution is a fact, not a guess. Dropping the line would discard the
    // strongest tamper evidence the deployment has; throwing would crash the verification path.
    await writeFile(
      anchorFile,
      `${JSON.stringify({ ts: "2026-01-01T00:00:00.000Z", maxAuditId: 9, headHash: "f".repeat(64) })}\n` +
        `${JSON.stringify({ ts: "2026-02-01T00:00:00.000Z", orgId: ORG_B, maxAuditId: 10, headHash: "0".repeat(64) })}\n` +
        "{ not json at all\n",
      "utf8",
    );
    const map = await readAnchorFile();
    expect(map).not.toBeNull();
    expect(map?.get(`${SEED_ORG_ID}:9`)).toBe("f".repeat(64));
    expect(map?.get(`${ORG_B}:10`)).toBe("0".repeat(64));
    // A single malformed line must not sink the whole external check.
    expect(map?.size).toBe(2);
  });

  it("returns null (honest 'no external record') when the file is missing", async () => {
    anchorFile = join(tmpdir(), "stopgap-anchors-does-not-exist", "nope.jsonl");
    await expect(readAnchorFile()).resolves.toBeNull();
  });
});

describe("verifyAnchors", () => {
  it("compares each anchor against ITS OWN org's chain", async () => {
    heads[ORG_A] = { id: 42, hash: "a".repeat(64) };
    heads[ORG_B] = { id: 41, hash: "b".repeat(64) };
    anchorRows = [
      { id: 2, orgId: ORG_B, maxAuditId: 41, headHash: "b".repeat(64) },
      { id: 1, orgId: ORG_A, maxAuditId: 42, headHash: "a".repeat(64) },
    ];
    const results = await verifyAnchors(fakeDb() as never);
    expect(results.map((r) => r.headMatches)).toEqual([true, true]);
  });

  it("reports a MISMATCH for an anchor relabelled into another org", async () => {
    heads[ORG_A] = { id: 42, hash: "a".repeat(64) };
    heads[ORG_B] = { id: 41, hash: "b".repeat(64) };
    // A DB writer edits `org_id` on org A's anchor to point at org B, leaving the hash alone.
    anchorRows = [{ id: 1, orgId: ORG_B, maxAuditId: 42, headHash: "a".repeat(64) }];
    const results = await verifyAnchors(fakeDb() as never);
    // Matching on `(org_id, id)` rather than on `id` alone is what makes this a mismatch: an id
    // is deployment-wide, so an id-only lookup would have resolved the row regardless of tenant
    // and verified green against a chain the anchor was never taken over.
    expect(results[0]?.headMatches).toBe(false);
  });

  it("narrows to one tenant's anchors when given an orgId (the console's integrity page)", async () => {
    heads[ORG_A] = { id: 42, hash: "a".repeat(64) };
    heads[ORG_B] = { id: 41, hash: "b".repeat(64) };
    anchorRows = [
      { id: 2, orgId: ORG_B, maxAuditId: 41, headHash: "b".repeat(64) },
      { id: 1, orgId: ORG_A, maxAuditId: 42, headHash: "a".repeat(64) },
    ];
    const results = await verifyAnchors(fakeDb() as never, undefined, ORG_A);
    expect(results).toHaveLength(1);
    expect(results[0]?.orgId).toBe(ORG_A);
  });

  it("reports externalMatches: null when there is no external record for that org+id", async () => {
    heads[ORG_A] = { id: 42, hash: "a".repeat(64) };
    anchorRows = [{ id: 1, orgId: ORG_A, maxAuditId: 42, headHash: "a".repeat(64) }];
    const results = await verifyAnchors(fakeDb() as never);
    // No anchor file was written in this test — honest "we have no outside record", never a pass.
    expect(results[0]?.externalMatches).toBeNull();
  });
});
