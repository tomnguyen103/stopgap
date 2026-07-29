import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./client.js";
import { withOrgDb } from "./org-context.js";
import {
  listEvidenceForSignal,
  recordEvidence,
  upsertSignals,
  type PersistableSignal,
} from "./signals.js";

/**
 * The signal and evidence WRITE paths, against a live Postgres.
 *
 * What cannot be asserted offline is what this file covers: that re-capturing an unchanged provider
 * record restates one row instead of growing the trail by one entry per poll forever, that a
 * CHANGED record lands as a new artifact, that the first capture time survives a restatement, and
 * that a row naming another tenant's signal is refused by the database rather than by a convention.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000e1";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000e2";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

function signalFor(orgId: string, sourceId: string): PersistableSignal {
  return {
    source: "openfda_shortage",
    sourceId,
    riskDomain: "shortage",
    entityType: "drug",
    entityIdentifier: "Heparin",
    title: "Drug shortage — Heparin",
    summary: "detail",
    severity: "high",
    severityScore: 0.7,
    confidence: 0.8,
    observedAt: "2026-07-01T00:00:00.000Z",
    publishedAt: "2026-07-01T00:00:00.000Z",
    lastFetchedAt: "2026-07-28T00:00:00.000Z",
    staleness: "aging",
    sourceResolved: false,
    evidenceUrl: "https://example.test/evidence",
    raw: { generic_name: "Heparin" },
    dedupeKey: `${orgId}:openfda_shortage:${sourceId}`,
    matchHints: { ndcs: [], rxcuis: [], names: ["Heparin"] },
  };
}

beforeAll(async () => {
  if (/stopgap:stopgap@/.test(DATABASE_URL)) {
    throw new Error("DATABASE_URL names the owner; these assertions need the app role");
  }
  for (const [id, slug] of [
    [ORG_A, "signals-org-a"],
    [ORG_B, "signals-org-b"],
  ] as const) {
    await raw`insert into organizations (id, slug, name) values (${id}, ${slug}, ${slug})
              on conflict (id) do nothing`;
  }
});

afterAll(async () => {
  for (const org of [ORG_A, ORG_B]) {
    await raw.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${org}, true)`;
      await tx`delete from signal_evidence where org_id = ${org}`;
      await tx`delete from risk_signals where org_id = ${org}`;
    });
  }
  await raw`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

describe("the evidence trail", () => {
  it("restates an unchanged capture instead of growing by a row per poll", async () => {
    const signalId = await withOrgDb(ORG_A, async (db) => {
      const [row] = await upsertSignals(db, ORG_A, [signalFor(ORG_A, "trail-1")]);
      return row!.id;
    });

    const capture = (contentHash: string, capturedAt: string, originUrl = "https://a.test/1") => ({
      signalId,
      type: "provider_record" as const,
      source: "openfda_shortage",
      sourceId: "trail-1",
      originUrl,
      contentHash,
      capturedAt: new Date(capturedAt),
    });

    // Three polls, one unchanged record.
    await withOrgDb(ORG_A, (db) =>
      recordEvidence(db, ORG_A, [capture("hash-1", "2026-07-01T00:00:00.000Z")]),
    );
    await withOrgDb(ORG_A, (db) =>
      recordEvidence(db, ORG_A, [capture("hash-1", "2026-07-02T00:00:00.000Z")]),
    );
    await withOrgDb(ORG_A, (db) =>
      recordEvidence(db, ORG_A, [
        capture("hash-1", "2026-07-03T00:00:00.000Z", "https://a.test/moved"),
      ]),
    );

    const afterUnchanged = await withOrgDb(ORG_A, (db) =>
      listEvidenceForSignal(db, ORG_A, signalId),
    );
    expect(afterUnchanged).toHaveLength(1);
    // The FIRST capture time survives: "when was this claim first evidenced" is the question the
    // trail answers, and the signal row already carries `lastFetchedAt` for the other one.
    expect(afterUnchanged[0]?.capturedAt.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // The pointer may move — a record re-published at a new URL is the same evidence.
    expect(afterUnchanged[0]?.originUrl).toBe("https://a.test/moved");

    // A CHANGED record is a different thing to have seen, and lands as its own artifact.
    await withOrgDb(ORG_A, (db) =>
      recordEvidence(db, ORG_A, [capture("hash-2", "2026-07-04T00:00:00.000Z")]),
    );
    const afterChange = await withOrgDb(ORG_A, (db) => listEvidenceForSignal(db, ORG_A, signalId));
    expect(afterChange).toHaveLength(2);
    // Newest capture first.
    expect(afterChange[0]?.contentHash).toBe("hash-2");
  });

  it("stores no provider content — only a pointer, an identifier and a fingerprint", async () => {
    // The assertion is about what the table CANNOT hold, so it reads the schema rather than a row.
    const columns = await raw`select column_name from information_schema.columns
                              where table_name = 'signal_evidence' order by column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "captured_at",
      "content_hash",
      "id",
      "org_id",
      "origin_url",
      "signal_id",
      "source",
      "source_id",
      "type",
    ]);
  });
});

describe("a tenant cannot file evidence against another tenant's signal", () => {
  it("is refused by the database, not by a convention", async () => {
    const foreignSignalId = await withOrgDb(ORG_B, async (db) => {
      const [row] = await upsertSignals(db, ORG_B, [signalFor(ORG_B, "foreign-1")]);
      return row!.id;
    });

    // Org A files an artifact naming org B's signal. `org_id` is org A's own, so `WITH CHECK`
    // passes and a plain foreign key would too — the signal genuinely exists. Only the COMPOSITE
    // key catches the pair being wrong.
    await expect(
      withOrgDb(ORG_A, (db) =>
        recordEvidence(db, ORG_A, [
          {
            signalId: foreignSignalId,
            type: "provider_record",
            source: "openfda_shortage",
            sourceId: "foreign-1",
            originUrl: "https://a.test/x",
            contentHash: "hash-x",
            capturedAt: new Date("2026-07-01T00:00:00.000Z"),
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a signal normalized for another tenant by name, before the database sees it", async () => {
    await expect(
      withOrgDb(ORG_A, (db) => upsertSignals(db, ORG_A, [signalFor(ORG_B, "mismatched")])),
    ).rejects.toThrow(/was not normalized for org/);
  });
});
