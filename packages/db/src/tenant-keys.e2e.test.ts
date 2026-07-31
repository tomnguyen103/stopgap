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
 * and this suite would go green while proving nothing. `beforeAll` refuses such a role outright.
 *
 * `23503` is Postgres' foreign_key_violation. It is the exact code the three keys that already did
 * this before ticket 21 (`risk_score_snapshots`, `signal_evidence`, `alert_events`) are asserted on
 * in `signals.e2e.test.ts`, and asserting the code rather than a message keeps the test off
 * Postgres' wording.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap_app:stopgap_app@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-0000000000fa";
const ORG_B = "bbbbbbbb-0000-0000-0000-0000000000fb";

/**
 * Deterministic ids, so a re-run cleans up after a previous crashed one — which is only true if
 * every write below either names its id or carries an `on conflict`. A bare insert with a natural
 * unique key turns a crashed run into a `23505` on the next one, which reads as a broken
 * constraint rather than as leftover state.
 */
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
  siteA: "66666666-0000-0000-0000-0000000000fa",
  siteB: "66666666-0000-0000-0000-0000000000fb",
  protocolA: "77777777-0000-0000-0000-0000000000fa",
  protocolB: "77777777-0000-0000-0000-0000000000fb",
  ackA: "88888888-0000-0000-0000-0000000000fa",
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
  // Asked of the SERVER, not of the connection string, the way `rls.e2e.test.ts` asks it. A url
  // pattern only catches the compose default; any other superuser would sail past it and take the
  // suite with it — the writes below would be measured against a role no policy applies to.
  const [role] = await raw`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  if (role?.rolsuper || role?.rolbypassrls) {
    throw new Error(
      `DATABASE_URL names ${role.rolsuper ? "a superuser" : "a BYPASSRLS role"}; ` +
        "a composite-key refusal has to be observed as the role the policies apply to",
    );
  }

  for (const [id, slug] of [
    [ORG_A, "tenant-keys-org-a"],
    [ORG_B, "tenant-keys-org-b"],
  ] as const) {
    await raw`insert into organizations (id, slug, name) values (${id}, ${slug}, ${slug})
              on conflict (id) do nothing`;
  }

  // One parent of each kind per tenant. Org B's rows are the ones org A will try to point at.
  for (const [org, caseId, itemId, supplierId, facilityId, siteId, protocolId] of [
    [ORG_A, ID.caseA, ID.itemA, ID.supplierA, ID.facilityA, ID.siteA, ID.protocolA],
    [ORG_B, ID.caseB, ID.itemB, ID.supplierB, ID.facilityB, ID.siteB, ID.protocolB],
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
      await tx`insert into supplier_sites (id, org_id, supplier_id, code)
               values (${siteId}, ${org}, ${supplierId}, ${"tk-site-" + org})
               on conflict (id) do nothing`;
      await tx`insert into facilities (id, org_id, code, name)
               values (${facilityId}, ${org}, ${"tk-fac-" + org}, 'fixture facility')
               on conflict (id) do nothing`;
      await tx`insert into protocols (id, org_id, key, title)
               values (${protocolId}, ${org}, ${"tk-proto-" + org}, 'fixture protocol')
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
  // Children before parents, and `audit_log` / `acknowledgments` before `cases` specifically:
  // those two keys REFUSE a delete rather than cascading, so the reverse order would leave the
  // fixture orgs undeletable and poison the next run.
  for (const org of [ORG_A, ORG_B]) {
    await asOrg(org, async (tx) => {
      await tx`delete from procurement_events where org_id = ${org}`;
      await tx`delete from inventory_snapshots where org_id = ${org}`;
      await tx`delete from item_suppliers where org_id = ${org}`;
      await tx`delete from item_identifiers where org_id = ${org}`;
      await tx`delete from supplier_sites where org_id = ${org}`;
      await tx`delete from acknowledgments where org_id = ${org}`;
      await tx`delete from audit_log where org_id = ${org}`;
      await tx`delete from protocol_versions where org_id = ${org}`;
      await tx`delete from protocols where org_id = ${org}`;
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

/**
 * ONE PROBE PER CONVERTED KEY, driven from a list rather than hand-rolled — the way
 * `rls.e2e.test.ts` drives its per-table assertions. Hand-rolled cases are how a key gets converted
 * in the migration and then quietly asserted by nothing: the first draft of this file covered seven
 * of fourteen and said nothing about the rest. The completeness check below is what keeps the list
 * honest, by asking the database which composite keys actually exist.
 *
 * Each probe writes a row whose `org_id` is org A's own and whose parent is org B's. Under the
 * plain keys these replaced, every one of them landed.
 */
const CROSS_TENANT_WRITES: readonly {
  key: string;
  write: (tx: postgres.TransactionSql) => Promise<unknown>;
}[] = [
  {
    key: "acknowledgments_org_case_fk",
    write: (tx) => tx`insert into acknowledgments (org_id, case_id, user_id, step)
                      values (${ORG_A}, ${ID.caseB}, ${ID.userA}, 2)`,
  },
  {
    key: "audit_log_org_case_fk",
    write: (tx) => tx`insert into audit_log (org_id, case_id, actor, action, detail, hash, prev_hash)
                      values (${ORG_A}, ${ID.caseB}, 'fixture', 'tenant-keys.probe', '{}'::jsonb,
                              ${"f".repeat(64)}, ${"0".repeat(64)})`,
  },
  {
    key: "protocol_versions_org_protocol_fk",
    write: (tx) => tx`insert into protocol_versions (org_id, protocol_id, version, body, authored_by)
                      values (${ORG_A}, ${ID.protocolB}, 1, 'fixture', 'agent')`,
  },
  {
    key: "protocol_versions_org_source_case_fk",
    write: (tx) => tx`insert into protocol_versions
                        (org_id, protocol_id, version, body, authored_by, source_case_id)
                      values (${ORG_A}, ${ID.protocolA}, 9, 'fixture', 'agent', ${ID.caseB})`,
  },
  {
    key: "item_identifiers_org_item_fk",
    write: (tx) => tx`insert into item_identifiers (org_id, item_id, type, value)
                      values (${ORG_A}, ${ID.itemB}, 'ndc', '00000-0000-00')`,
  },
  {
    key: "supplier_sites_org_supplier_fk",
    write: (tx) => tx`insert into supplier_sites (org_id, supplier_id, code)
                      values (${ORG_A}, ${ID.supplierB}, 'tk-site-x')`,
  },
  {
    key: "item_suppliers_org_item_fk",
    write: (tx) => tx`insert into item_suppliers (org_id, item_id, supplier_id)
                      values (${ORG_A}, ${ID.itemB}, ${ID.supplierA})`,
  },
  {
    key: "item_suppliers_org_supplier_fk",
    write: (tx) => tx`insert into item_suppliers (org_id, item_id, supplier_id)
                      values (${ORG_A}, ${ID.itemA}, ${ID.supplierB})`,
  },
  {
    key: "item_suppliers_org_site_fk",
    write: (tx) => tx`insert into item_suppliers (org_id, item_id, supplier_id, site_id)
                      values (${ORG_A}, ${ID.itemA}, ${ID.supplierA}, ${ID.siteB})`,
  },
  {
    key: "inventory_snapshots_org_facility_fk",
    write: (tx) => tx`insert into inventory_snapshots (org_id, facility_id, item_id, on_hand, captured_at)
                      values (${ORG_A}, ${ID.facilityB}, ${ID.itemA}, 5, now())`,
  },
  {
    key: "inventory_snapshots_org_item_fk",
    write: (tx) => tx`insert into inventory_snapshots (org_id, facility_id, item_id, on_hand, captured_at)
                      values (${ORG_A}, ${ID.facilityA}, ${ID.itemB}, 5, now())`,
  },
  {
    key: "procurement_events_org_facility_fk",
    write: (tx) => tx`insert into procurement_events (org_id, facility_id, item_id, ordered_at, quantity)
                      values (${ORG_A}, ${ID.facilityB}, ${ID.itemA}, now(), 1)`,
  },
  {
    key: "procurement_events_org_item_fk",
    write: (tx) => tx`insert into procurement_events (org_id, facility_id, item_id, ordered_at, quantity)
                      values (${ORG_A}, ${ID.facilityA}, ${ID.itemB}, now(), 1)`,
  },
  {
    key: "procurement_events_org_supplier_fk",
    write: (tx) => tx`insert into procurement_events
                        (org_id, facility_id, item_id, supplier_id, ordered_at, quantity)
                      values (${ORG_A}, ${ID.facilityA}, ${ID.itemA}, ${ID.supplierB}, now(), 1)`,
  },
];

describe("a tenant row cannot point at another tenant's row", () => {
  for (const probe of CROSS_TENANT_WRITES) {
    it(`is refused by ${probe.key}`, async () => {
      // The CONSTRAINT as well as the code: `23503` alone would also be satisfied by the row being
      // refused by some other foreign key on the same insert, which would leave the key this probe
      // exists for completely unexercised while the test went green.
      await expect(asOrg(ORG_A, probe.write)).rejects.toMatchObject({
        code: "23503",
        constraint_name: probe.key,
      });
    });
  }

  it("probes every composite tenant key that exists, so none can be added unasserted", async () => {
    const rows = await raw`
      select conname from pg_constraint
       where contype = 'f'
         and array_length(conkey, 1) = 2
         and connamespace = 'public'::regnamespace
         and conrelid::regclass::text in (
           'acknowledgments', 'audit_log', 'protocol_versions', 'item_identifiers',
           'supplier_sites', 'item_suppliers', 'inventory_snapshots', 'procurement_events')`;
    const inDatabase = rows.map((r) => r.conname as string).sort();
    expect(inDatabase).toEqual([...CROSS_TENANT_WRITES.map((p) => p.key)].sort());
  });

  it("nulls only the site when a site is deleted, not the tenant it belonged to", async () => {
    // The hand-written half of migration 0021, and the reason it is hand-written: a composite
    // `ON DELETE SET NULL` nulls EVERY referencing column, and `org_id` is NOT NULL — so the
    // generated form would not have failed here at creation, it would have failed the first time
    // somebody deleted a site, in production, long after the migration reported success.
    await asOrg(ORG_A, async (tx) => {
      await tx`insert into item_suppliers (org_id, item_id, supplier_id, site_id)
               values (${ORG_A}, ${ID.itemA}, ${ID.supplierA}, ${ID.siteA})
               on conflict (org_id, item_id, supplier_id) do update set site_id = ${ID.siteA}`;
      await tx`delete from supplier_sites where id = ${ID.siteA}`;
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
      (tx) => tx`insert into acknowledgments (id, org_id, case_id, user_id, step)
                 values (${ID.ackA}, ${ORG_A}, ${ID.caseA}, ${ID.userA}, 1)
                 on conflict (id) do nothing`,
    );
    const [row] = await asOrg(
      ORG_A,
      (tx) => tx`select count(*)::int as n from acknowledgments where case_id = ${ID.caseA}`,
    );
    expect(row?.n).toBe(1);
  });
});
