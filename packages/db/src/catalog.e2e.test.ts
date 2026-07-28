import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planImport } from "@stopgap/catalog";
import { importCatalog, RefusedImportError } from "./catalog.js";
import { closeDb } from "./client.js";

/**
 * The WRITE half of catalog import (ticket 15), against a live Postgres.
 *
 * The pure half — parsing, coercion, per-row errors — is asserted offline in
 * `packages/catalog/src/catalog.test.ts` and needs nothing. What cannot be asserted offline is the
 * half that only means anything against a database: that a bad file leaves NOTHING behind, that a
 * corrected re-upload updates rather than duplicates, and that one tenant's import is invisible to
 * another. Those three are the ticket's behavioural checkboxes, so they are tested here rather
 * than described in a comment.
 *
 *   DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap pnpm test:rls
 *
 * `DATABASE_URL` must name the APPLICATION role — the one the policies apply to. Run under the
 * owner and the isolation assertion below would pass without proving anything.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000ca";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000cb";

const raw = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });

/** Read a tenant's rows directly, inside that tenant's own scope. */
async function asOrg<T>(orgId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return raw.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

const ITEMS = [
  "sku,name,generic_name,unit,ndc",
  "HEP-5K,Heparin 5000 units/mL,heparin sodium,vial,63323-540-01",
  "SAL-09,Sodium Chloride 0.9%,sodium chloride,bag,00338-0049-04",
].join("\n");

beforeAll(async () => {
  if (/stopgap:stopgap@/.test(DATABASE_URL)) {
    throw new Error("DATABASE_URL names the owner; the isolation assertion needs the app role");
  }
  for (const [id, slug] of [
    [ORG_A, "catalog-org-a"],
    [ORG_B, "catalog-org-b"],
  ] as const) {
    await raw`insert into organizations (id, slug, name) values (${id}, ${slug}, ${slug})
              on conflict (id) do nothing`;
  }
});

afterAll(async () => {
  for (const org of [ORG_A, ORG_B]) {
    await asOrg(org, async (tx) => {
      await tx`delete from procurement_events where org_id = ${org}`;
      await tx`delete from inventory_snapshots where org_id = ${org}`;
      await tx`delete from item_suppliers where org_id = ${org}`;
      await tx`delete from item_identifiers where org_id = ${org}`;
      await tx`delete from supplier_sites where org_id = ${org}`;
      await tx`delete from suppliers where org_id = ${org}`;
      await tx`delete from facilities where org_id = ${org}`;
      await tx`delete from items where org_id = ${org}`;
    });
  }
  await raw`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await raw.end({ timeout: 5 });
  await closeDb();
});

describe("importing a catalog file", () => {
  it("writes items with every identifier the row carried", async () => {
    const result = await importCatalog(ORG_A, planImport("items", ITEMS));
    expect(result).toEqual({ kind: "items", rowsApplied: 2 });

    const identifiers = await asOrg(
      ORG_A,
      (tx) => tx`select type, value from item_identifiers where org_id = ${ORG_A} order by type`,
    );
    expect(identifiers.map((r) => r.type)).toEqual(["ndc", "ndc", "sku", "sku"]);
  });

  it("updates rather than duplicates when the same file is uploaded again", async () => {
    await importCatalog(ORG_A, planImport("items", ITEMS));
    const rows = await asOrg(ORG_A, (tx) => tx`select id from items where org_id = ${ORG_A}`);
    expect(rows).toHaveLength(2);
  });

  it("matches on the IDENTIFIER, so a corrected sku renames the item it already had", async () => {
    const corrected = [
      "sku,name,generic_name,unit,ndc",
      // Same NDC, a sku the administrator has now spelled correctly.
      "HEP-5000,Heparin 5000 units/mL,heparin sodium,vial,63323-540-01",
    ].join("\n");
    await importCatalog(ORG_A, planImport("items", corrected));

    const rows = await asOrg(
      ORG_A,
      (tx) => tx`select sku from items where org_id = ${ORG_A} order by sku`,
    );
    // Two items still — the heparin row was RENAMED, not joined by a third.
    expect(rows.map((r) => r.sku)).toEqual(["HEP-5000", "SAL-09"]);

    // ...and the old sku identifier is gone, so it cannot go on matching signals.
    const skus = await asOrg(
      ORG_A,
      (tx) => tx`select value from item_identifiers where org_id = ${ORG_A} and type = 'sku'`,
    );
    expect(skus.map((r) => r.value).sort()).toEqual(["HEP-5000", "SAL-09"]);
  });

  it("refuses a plan carrying errors before writing anything", async () => {
    const before = await asOrg(ORG_A, (tx) => tx`select id from items where org_id = ${ORG_A}`);
    const bad = planImport("items", ["sku,name", "OK-1,Fine", ",Nameless sku"].join("\n"));
    await expect(importCatalog(ORG_A, bad)).rejects.toBeInstanceOf(RefusedImportError);
    const after = await asOrg(ORG_A, (tx) => tx`select id from items where org_id = ${ORG_A}`);
    expect(after).toHaveLength(before.length);
  });

  it("rolls back the whole file when a row fails mid-write", async () => {
    // Every row coerces, so the plan is clean — the failure happens at the WRITE, on row 3, which
    // names an item this tenant does not stock. Rows 1 and 2 must not survive it.
    const inventory = [
      "facility_code,facility_name,sku,on_hand,captured_at",
      "MAIN,Main Pharmacy,HEP-5000,10,2026-07-01",
      "MAIN,Main Pharmacy,SAL-09,20,2026-07-01",
      "MAIN,Main Pharmacy,NOT-STOCKED,5,2026-07-01",
    ].join("\n");
    await expect(importCatalog(ORG_A, planImport("inventory", inventory))).rejects.toThrow(
      /no item with sku NOT-STOCKED/,
    );
    const rows = await asOrg(
      ORG_A,
      (tx) => tx`select id from inventory_snapshots where org_id = ${ORG_A}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("creates facilities on first sight, for a file that never names one", async () => {
    // The regression this guards: a `set` clause of nothing but `undefined` throws "No values to
    // set" in drizzle, and a procurement file carries no facility name at all — so every
    // procurement import failed before writing a row.
    const procurement = [
      "facility_code,sku,ordered_at,quantity,order_ref",
      "MAIN,HEP-5000,2026-07-01,100,PO-1",
      "MAIN,HEP-5000,2026-07-01,250,PO-2",
    ].join("\n");
    const result = await importCatalog(ORG_A, planImport("procurement", procurement));
    expect(result.rowsApplied).toBe(2);

    // Two orders, same item, same facility, same DAY — kept apart by their purchase-order
    // references rather than collapsed into one.
    const events = await asOrg(
      ORG_A,
      (tx) => tx`select order_ref, quantity from procurement_events where org_id = ${ORG_A}
                 order by order_ref`,
    );
    expect(events.map((r) => r.order_ref)).toEqual(["PO-1", "PO-2"]);
  });

  it("restates an order rather than duplicating it when the same reference is re-uploaded", async () => {
    const corrected = [
      "facility_code,sku,ordered_at,quantity,order_ref",
      "MAIN,HEP-5000,2026-07-01,120,PO-1",
    ].join("\n");
    await importCatalog(ORG_A, planImport("procurement", corrected));
    const events = await asOrg(
      ORG_A,
      (tx) => tx`select order_ref, quantity from procurement_events where org_id = ${ORG_A}
                 order by order_ref`,
    );
    expect(events).toHaveLength(2);
    expect(Number(events[0]?.quantity)).toBe(120);
  });
});

describe("an import belongs to the tenant that ran it", () => {
  it("is invisible from another tenant's scope", async () => {
    await importCatalog(ORG_B, planImport("items", ["sku,name", "B-ONLY,Org B item"].join("\n")));

    const seenByB = await asOrg(
      ORG_B,
      (tx) => tx`select sku from items where org_id = ${ORG_B}`,
    );
    expect(seenByB.map((r) => r.sku)).toEqual(["B-ONLY"]);

    // Org A asks for org B's rows explicitly and still gets none — the policy, not the predicate.
    const seenByA = await asOrg(ORG_A, (tx) => tx`select sku from items where org_id = ${ORG_B}`);
    expect(seenByA).toHaveLength(0);
  });

  it("lets both tenants hold the same sku, because uniqueness is per organization", async () => {
    await importCatalog(ORG_B, planImport("items", ["sku,name", "SAL-09,Org B saline"].join("\n")));
    const a = await asOrg(
      ORG_A,
      (tx) => tx`select name from items where org_id = ${ORG_A} and sku = 'SAL-09'`,
    );
    const b = await asOrg(
      ORG_B,
      (tx) => tx`select name from items where org_id = ${ORG_B} and sku = 'SAL-09'`,
    );
    expect(a[0]?.name).toBe("Sodium Chloride 0.9%");
    expect(b[0]?.name).toBe("Org B saline");
  });
});
