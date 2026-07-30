import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "./client.js";

/**
 * Composite tenant foreign keys (ticket 21), against a live Postgres.
 *
 * THE CLAIM: a row filed under one hospital cannot point at another hospital's row — and it is the
 * DATABASE that refuses, not a convention every future caller has to remember.
 *
 * Why a plain foreign key is not enough, and why this can only be proven here: the referential
 * check runs with row-level security BYPASSED, and `org_id` is written by the calling function. So
 * a row naming another tenant's parent satisfies the foreign key (the parent genuinely exists) AND
 * the policy's `WITH CHECK` (the `org_id` written is the caller's own). Both gates pass. Only a key
 * over the PAIR catches it. Every insert below is one that would land today under a plain key.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 *
 * `DATABASE_URL` must name the APPLICATION role — the one the policies apply to — for the reason
 * `rls.e2e.test.ts` spells out at length: under the owner every policy is bypassed unconditionally,
 * and this suite would go green while proving nothing. `beforeAll` refuses the owner outright.
 *
 * `23503` is Postgres' foreign_key_violation. It is the exact code the three keys that already do
 * this (`risk_score_snapshots`, `signal_evidence`, `alert_events`) are asserted on in
 * `signals.e2e.test.ts`, and asserting the code rather than a message keeps the test off Postgres'
 * wording.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000fa";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000fb";

/** Deterministic ids, so a re-run cleans up after a previous crashed one. */
const ID = {
  caseA: "11111111-0000-0000-0000-0000000000fa",
  caseB: "11111111-0000-0000-0000-0000000000fb",
  userA: "22222222-0000-0000-0000-0000000000fa",
  itemA: "33333333-0000-0000-0000-0000000000fa",
  itemB: "33333333-0000-0000-0000-0000000000fb",
  supplierA: "44444444-0000-0000-0000-0000000000fa",
  supplierB: "44444444-0000-0000-0000-0000000000fb",
  facilityA: "55555555-0000-0000-0000-0000000000fa",
  facilityB: "55555555-0000-0000-0000-0000000000fb",
} as const;

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

/** Write as a tenant, inside that tenant's own scope — the way the application always writes. */
async function asOrg<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

beforeAll(async () => {
  if (/stopgap:stopgap@/.test(DATABASE_URL)) {
    throw new Error("DATABASE_URL names the owner; a composite-key refusal needs the app role");
  }
  for (const [id, slug] of [
    [ORG_A, "tenant-keys-org-a"],
    [ORG_B, "tenant-keys-org-b"],
  ] as const) {
    await raw`insert into organizations (id, slug, name) values (${id}, ${slug}, ${slug})
              on conflict (id) do nothing`;
  }

  // One parent of each kind per tenant. Org B's rows are the ones org A will try to point at.
  for (const [org, caseId, itemId, supplierId, facilityId] of [
    [ORG_A, ID.caseA, ID.itemA, ID.supplierA, ID.facilityA],
    [ORG_B, ID.caseB, ID.itemB, ID.supplierB, ID.facilityB],
  ] as const) {
    await asOrg(org, async (tx) => {
      await tx`insert into cases (id, org_id, key, workflow_id, source, source_id, generic_name, status)
               values (${caseId}, ${org}, ${"tk-" + org}, ${"case-tk-" + org}, 'openfda',
                       ${"tk-src-" + org}, 'heparin sodium', 'awaiting_review')
               on conflict (id) do nothing`;
      await tx`insert into items (id, org_id, sku, name)
               values (${itemId}, ${org}, ${"tk-sku-" + org}, 'fixture item')
               on conflict (id) do nothing`;
      await tx`insert into suppliers (id, org_id, code, name)
               values (${supplierId}, ${org}, ${"tk-sup-" + org}, 'fixture supplier')
               on conflict (id) do nothing`;
      await tx`insert into facilities (id, org_id, code, name)
               values (${facilityId}, ${org}, ${"tk-fac-" + org}, 'fixture facility')
               on conflict (id) do nothing`;
    });
  }

  // A user of org A, so the acknowledgment below fails on the CASE pair and nothing else.
  await asOrg(ORG_A, async (tx) => {
    await tx`insert into users (id, org_id, email)
             values (${ID.userA}, ${ORG_A}, 'tenant-keys-a@example.test')
             on conflict (id) do nothing`;
  });
});

afterAll(async () => {
  for (const org of [ORG_A, ORG_B]) {
    await asOrg(org, async (tx) => {
      await tx`delete from inventory_snapshots where org_id = ${org}`;
      await tx`delete from item_suppliers where org_id = ${org}`;
      await tx`delete from item_identifiers where org_id = ${org}`;
      await tx`delete from supplier_sites where org_id = ${org}`;
      await tx`delete from acknowledgments where org_id = ${org}`;
      await tx`delete from audit_log where org_id = ${org}`;
      await tx`delete from suppliers where org_id = ${org}`;
      await tx`delete from facilities where org_id = ${org}`;
      await tx`delete from items where org_id = ${org}`;
      await tx`delete from users where org_id = ${org}`;
      await tx`delete from cases where org_id = ${org}`;
    });
  }
  await raw`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

describe("a tenant row cannot point at another tenant's row", () => {
  it("refuses an acknowledgment of another tenant's case", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into acknowledgments (org_id, case_id, user_id, step)
                   values (${ORG_A}, ${ID.caseB}, ${ID.userA}, 1)`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an audit entry against another tenant's case", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into audit_log (org_id, case_id, actor, action, detail, hash, prev_hash)
                   values (${ORG_A}, ${ID.caseB}, 'fixture', 'tenant-keys.probe', '{}'::jsonb,
                           ${"f".repeat(64)}, ${"0".repeat(64)})`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an identifier filed against another tenant's item", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into item_identifiers (org_id, item_id, type, value)
                   values (${ORG_A}, ${ID.itemB}, 'ndc', '00000-0000-00')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses a site filed against another tenant's supplier", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into supplier_sites (org_id, supplier_id, code)
                   values (${ORG_A}, ${ID.supplierB}, 'tk-site-a')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an item/supplier link naming another tenant's item", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into item_suppliers (org_id, item_id, supplier_id)
                   values (${ORG_A}, ${ID.itemB}, ${ID.supplierA})`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an item/supplier link naming another tenant's supplier", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into item_suppliers (org_id, item_id, supplier_id)
                   values (${ORG_A}, ${ID.itemA}, ${ID.supplierB})`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an inventory snapshot naming another tenant's facility", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into inventory_snapshots (org_id, facility_id, item_id, on_hand, captured_at)
                   values (${ORG_A}, ${ID.facilityB}, ${ID.itemA}, 5, now())`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("nulls only the site when a site is deleted, not the tenant it belonged to", async () => {
    // The hand-written half of migration 0021, and the reason it is hand-written: a composite
    // `ON DELETE SET NULL` nulls EVERY referencing column, and `org_id` is NOT NULL — so the
    // generated form would not have failed here at creation, it would have failed the first time
    // somebody deleted a site, in production, long after the migration reported success.
    const siteId = "66666666-0000-0000-0000-0000000000fa";
    await asOrg(ORG_A, async (tx) => {
      await tx`insert into supplier_sites (id, org_id, supplier_id, code)
               values (${siteId}, ${ORG_A}, ${ID.supplierA}, 'tk-site-live')`;
      await tx`insert into item_suppliers (org_id, item_id, supplier_id, site_id)
               values (${ORG_A}, ${ID.itemA}, ${ID.supplierA}, ${siteId})`;
      await tx`delete from supplier_sites where id = ${siteId}`;
    });

    const [row] = await asOrg(
      ORG_A,
      (tx) => tx`select org_id, site_id from item_suppliers
                 where item_id = ${ID.itemA} and supplier_id = ${ID.supplierA}`,
    );
    // The link survives the site, still filed under its own tenant.
    expect(row?.site_id).toBeNull();
    expect(row?.org_id).toBe(ORG_A);
  });

  it("still accepts the same row when both sides are the caller's own", async () => {
    // The control. Without it a suite that refused EVERYTHING — a broken constraint, a wrong column
    // pair — would read exactly as green as one that refuses only the cross-tenant case.
    await asOrg(
      ORG_A,
      (tx) => tx`insert into acknowledgments (org_id, case_id, user_id, step)
                 values (${ORG_A}, ${ID.caseA}, ${ID.userA}, 1)`,
    );
    const [row] = await asOrg(
      ORG_A,
      (tx) => tx`select count(*)::int as n from acknowledgments where case_id = ${ID.caseA}`,
    );
    expect(row?.n).toBe(1);
  });
});
