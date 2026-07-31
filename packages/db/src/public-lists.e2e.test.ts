import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./client.js";
import { withOrgDb } from "./org-context.js";
import {
  getSignalForApi,
  listCatalogItemsPage,
  listScoresPage,
  listSignalsPageForApi,
} from "./public-lists.js";

/**
 * The public API's read queries against a live Postgres (ticket 19: "a key cannot read another
 * organization's data").
 *
 * The route tests mock this module out, so the predicates themselves — the `org_id` filters, the
 * COMPOSITE join between a snapshot and its signal, and the `distinct on` that picks the latest
 * snapshot — are only meaningful here. Two tenants are seeded with deliberately similar rows so a
 * missing predicate shows up as another hospital's data in the response rather than as an empty
 * result that looks like a passing test.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 *
 * `DATABASE_URL` must name the APPLICATION role, for the same reason `rls.e2e.test.ts` insists:
 * under the owner every isolation assertion below passes while proving nothing.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-00000000019a";
const ORG_B = "bbbbbbbb-0000-0000-0000-00000000019b";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

async function asOrg<T>(
  orgId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** One signal, one item and two score snapshots per tenant, differing only in which tenant holds them. */
async function seed(orgId: string, label: string): Promise<void> {
  await asOrg(orgId, async (tx) => {
    const [signal] = await tx`
      insert into risk_signals (
        org_id, source, source_id, risk_domain, entity_type, entity_identifier, title, summary,
        severity, severity_score, confidence, observed_at, published_at, last_fetched_at, staleness,
        evidence_url, raw, dedupe_key, match_hints
      ) values (
        ${orgId}, 'openfda-drug', ${`${label}-1`}, 'shortage', 'drug', ${`${label}-cefazolin`},
        ${`${label} cefazolin shortage`}, 'seeded', 'high', 0.7, 0.9, now(), now(), now(), 'fresh',
        'https://example.test', '{}'::jsonb, ${`${orgId}:openfda-drug:${label}-1`},
        '{"ndcs":[],"rxcuis":[],"names":[]}'::jsonb
      ) returning id`;
    const signalId = (signal as { id: string }).id;

    // Two snapshots, an hour apart: only the newer one may appear in the score list.
    await tx`insert into risk_score_snapshots (org_id, signal_id, score, band, components, reachable_max, scorer_version, computed_at)
             values (${orgId}, ${signalId}, 11.00, 'low', '{}'::jsonb, 100.00, 'scorer-test', now() - interval '1 hour')`;
    await tx`insert into risk_score_snapshots (org_id, signal_id, score, band, components, reachable_max, scorer_version, computed_at)
             values (${orgId}, ${signalId}, 88.00, 'critical', '{}'::jsonb, 100.00, 'scorer-test', now())`;

    await tx`insert into items (org_id, sku, name, generic_name, unit)
             values (${orgId}, ${`${label}-SKU`}, ${`${label} cefazolin 1g`}, 'cefazolin', 'vial')`;
  });
}

beforeAll(async () => {
  if (/stopgap:stopgap@/.test(DATABASE_URL)) {
    throw new Error("DATABASE_URL names the owner; the isolation assertions need the app role");
  }
  for (const [id, slug] of [
    [ORG_A, "public-lists-org-a"],
    [ORG_B, "public-lists-org-b"],
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
      await tx`delete from items where org_id = ${org}`;
    });
  }
  await raw`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

const page = { limit: 50, offset: 0 };

describe("the public API's list queries are tenant-scoped", () => {
  it("lists only this tenant's signals, and counts only this tenant's rows", async () => {
    const a = await withOrgDb(ORG_A, (db) => listSignalsPageForApi(db, ORG_A, page));
    expect(a.rows.map((r) => r.entityIdentifier)).toEqual(["alpha-cefazolin"]);
    expect(a.total).toBe(1);

    const b = await withOrgDb(ORG_B, (db) => listSignalsPageForApi(db, ORG_B, page));
    expect(b.rows.map((r) => r.entityIdentifier)).toEqual(["beta-cefazolin"]);
  });

  it("refuses another tenant's signal by key — indistinguishable from one that does not exist", async () => {
    const key = `${ORG_B}:openfda-drug:beta-1`;
    expect(await withOrgDb(ORG_A, (db) => getSignalForApi(db, ORG_A, key))).toBeUndefined();
    expect(await withOrgDb(ORG_B, (db) => getSignalForApi(db, ORG_B, key))).toBeDefined();
  });

  it("returns the LATEST snapshot per signal, and only this tenant's", async () => {
    const a = await withOrgDb(ORG_A, (db) => listScoresPage(db, ORG_A, page));
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.title).toContain("alpha");
    // 88, not the hour-old 11 — one row per signal, newest first.
    expect(Number(a.rows[0]?.score)).toBe(88);
    expect(a.rows[0]?.band).toBe("critical");
  });

  it("filters scores by band without leaking the other tenant's rows", async () => {
    const filtered = await withOrgDb(ORG_A, (db) =>
      listScoresPage(db, ORG_A, { ...page, filters: { band: ["low"] } }),
    );
    // The only `low` snapshot is the superseded one, which is not the latest — so nothing matches.
    expect(filtered.rows).toHaveLength(0);
    expect(filtered.total).toBe(0);
  });

  it("lists only this tenant's catalog items, including under a search term", async () => {
    const a = await withOrgDb(ORG_A, (db) =>
      listCatalogItemsPage(db, ORG_A, { ...page, q: "cefazolin" }),
    );
    expect(a.rows.map((r) => r.sku)).toEqual(["alpha-SKU"]);
    expect(a.total).toBe(1);
  });

  it("treats a `%` search term as a literal, not as a wildcard matching every row", async () => {
    const wildcard = await withOrgDb(ORG_A, (db) =>
      listCatalogItemsPage(db, ORG_A, { ...page, q: "%" }),
    );
    expect(wildcard.rows).toHaveLength(0);
  });
});
