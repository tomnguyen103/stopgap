import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "./audit.js";
import { closeDb } from "./client.js";
import { withOrgDb } from "./org-context.js";
import { sweepOrgRetention, type RetentionWindows } from "./retention.js";

/**
 * The retention sweep against a live Postgres (ticket 18).
 *
 * Three of the ticket's checkboxes are only meaningful with a database in front of them: that the
 * sweep removes what is past its window, that it CANNOT reach another tenant's rows, and that the
 * hash-chained audit log still verifies afterwards. Two tenants are seeded with identical expired
 * rows so a missing `org_id` predicate destroys the other tenant's data rather than producing a
 * quietly passing empty result.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 *
 * `DATABASE_URL` must name the APPLICATION role: under the owner the isolation assertion passes
 * while proving nothing.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-00000000018a";
const ORG_B = "bbbbbbbb-0000-0000-0000-00000000018b";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

async function asOrg<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** One expired signal (with a snapshot) and one fresh signal, per tenant. */
async function seed(orgId: string, label: string): Promise<void> {
  await asOrg(orgId, async (tx) => {
    for (const [age, suffix] of [
      ["400 days", "old"],
      ["1 day", "new"],
    ] as const) {
      const [signal] = await tx`
        insert into risk_signals (
          org_id, source, source_id, risk_domain, entity_type, entity_identifier, title, summary,
          severity, severity_score, confidence, observed_at, published_at, last_fetched_at,
          staleness, evidence_url, raw, dedupe_key, match_hints
        ) values (
          ${orgId}, 'openfda-drug', ${`${label}-${suffix}`}, 'shortage', 'drug', 'cefazolin',
          ${`${label} ${suffix}`}, 'seeded', 'high', 0.7, 0.9,
          now() - ${age}::interval, now() - ${age}::interval, now(), 'fresh',
          'https://example.test', '{}'::jsonb, ${`${orgId}:openfda-drug:${label}-${suffix}`},
          '{"ndcs":[],"rxcuis":[],"names":[]}'::jsonb
        ) returning id`;
      const signalId = (signal as { id: string }).id;
      await tx`insert into risk_score_snapshots (org_id, signal_id, score, band, components,
                                                 reachable_max, scorer_version, computed_at)
               values (${orgId}, ${signalId}, 50.00, 'moderate', '{}'::jsonb, 100.00, 'scorer-test',
                       now() - ${age}::interval)`;
    }
  });
}

/** 180 days for signals and snapshots; every other kind left alone for this suite. */
const WINDOWS: RetentionWindows = {
  riskSignals: 180,
  riskScoreSnapshots: 180,
  alertEvents: null,
  inventorySnapshots: null,
  procurementEvents: null,
};

beforeAll(async () => {
  if (/stopgap:stopgap@/.test(DATABASE_URL)) {
    throw new Error("DATABASE_URL names the owner; the isolation assertion needs the app role");
  }
  for (const [id, slug] of [
    [ORG_A, "retention-org-a"],
    [ORG_B, "retention-org-b"],
  ] as const) {
    await raw`insert into organizations (id, slug, name) values (${id}, ${slug}, ${slug})
              on conflict (id) do nothing`;
  }
  await seed(ORG_A, "alpha");
  await seed(ORG_B, "beta");
});

afterAll(async () => {
  for (const org of [ORG_A, ORG_B]) {
    await asOrg(org, async (tx) => {
      await tx`delete from risk_score_snapshots where org_id = ${org}`;
      await tx`delete from risk_signals where org_id = ${org}`;
      await tx`delete from audit_log where org_id = ${org}`;
    });
  }
  await raw`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

async function signalKeys(orgId: string): Promise<string[]> {
  const rows = await asOrg(
    orgId,
    (tx) => tx`select source_id from risk_signals where org_id = ${orgId} order by source_id`,
  );
  return rows.map((r) => String(r.source_id));
}

describe("a retention sweep", () => {
  it("removes what is past its window, keeps what is not, and leaves the other tenant alone", async () => {
    const result = await sweepOrgRetention(ORG_A, new Date(), WINDOWS);

    expect(await signalKeys(ORG_A)).toEqual(["alpha-new"]);
    // The other tenant's expired rows are untouched: a sweep is one organization's policy applied
    // to one organization's rows, never a deployment-wide delete that happens to be called per org.
    expect(await signalKeys(ORG_B)).toEqual(["beta-new", "beta-old"]);

    expect(result.counts.riskSignals).toBe(1);
    // The expired signal's snapshot went WITH the signal (cascade), so it is not counted twice.
    expect(result.counts.riskScoreSnapshots).toBe(0);
  });

  it("records the run in the swept tenant's audit chain, and the chain still verifies", async () => {
    const countEntries = async () => {
      const rows = await asOrg(
        ORG_A,
        (tx) => tx`select count(*)::int as n from audit_log where org_id = ${ORG_A}`,
      );
      return Number(rows[0]?.n ?? 0);
    };
    const before = await countEntries();
    await sweepOrgRetention(ORG_A, new Date(), WINDOWS);

    const entries = await asOrg(
      ORG_A,
      (tx) => tx`select detail from audit_log
                 where org_id = ${ORG_A} and action = 'retention.sweep'`,
    );
    // A run that removed nothing and a run that never happened must not look the same from outside.
    expect(entries.length).toBeGreaterThan(0);
    // The sweep only ever APPENDS: the chain grows and still verifies end to end, which is the
    // ticket's "audit chain integrity survives cleanup" — no entry is ever removed by retention.
    expect(await countEntries()).toBeGreaterThan(before);
    expect((await withOrgDb(ORG_A, (db) => verifyAuditChain(db, ORG_A))).ok).toBe(true);
  });
});
