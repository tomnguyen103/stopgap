import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAuditHash, verifyAuditChain, GENESIS_HASH } from "./audit.js";
import type { Db } from "./client.js";
import * as schema from "./schema.js";
import { SEED_ORG_ID } from "./orgs.js";

/**
 * ============================================================================================
 * THE MIGRATION TEST. REQUIRES A LIVE POSTGRES. NOT PART OF `pnpm gate` / `pnpm test`.
 * ============================================================================================
 *
 * `docs/multi-tenancy.md` says plainly that RLS behaviour and the migrations are the two things
 * this repo cannot verify without a database. `rls.e2e.test.ts` closed the first gap. This closes
 * the second, and it exists because 0013 is not an ordinary migration: it adds `org_id` to eight
 * tables that already have rows in them, backfills every one of those rows into the seed org, and
 * does it to a table (`audit_log`) whose rows are a HASH CHAIN. "The migration applies cleanly" is
 * therefore not the interesting claim — the interesting claim is that it applies without destroying
 * or invalidating anything, and the only way to find out is to run it against data.
 *
 * WHAT IS ASSERTED, against a scratch database seeded with PRE-0013 rows:
 *   1. every seeded row still exists afterwards (a backfill that dropped rows would otherwise show
 *      up as a smaller — and entirely plausible-looking — table);
 *   2. every row's `org_id` is the seed org, with none left NULL (the NOT NULL is enforced by the
 *      schema; that all of them landed in the RIGHT org is not);
 *   3. `verifyAuditChain(seedOrg)` is still green ACROSS the 0013 boundary. This is the assertion
 *      the whole file is for. Adding a column to a hashed row is safe only because `v1`'s payload
 *      is frozen and does not include `org_id`; if anyone ever "tidied" the v1 hash to include the
 *      new field, or the migration rewrote a hashed column in passing, every historical entry in
 *      every deployment would become permanently unverifiable and the audit chain would report
 *      tampering that never happened. Nothing else in the suite would catch that.
 *
 * To run it:
 *
 *   1. `pnpm infra:up`
 *   2. `DATABASE_URL_MAINTENANCE=postgres://stopgap:stopgap@localhost:5433/stopgap pnpm test:rls`
 *
 * It uses `DATABASE_URL_MAINTENANCE` rather than `DATABASE_URL` deliberately: `rls.e2e.test.ts`
 * REFUSES to run unless `DATABASE_URL` names a role the policies apply to, and that role cannot
 * CREATE DATABASE. The owner connection is the one that can, and it is also the role migrations
 * genuinely run as in a deployment — so the test exercises the real ownership arrangement rather
 * than a convenient one. Everything happens in a throwaway database that is dropped afterwards; the
 * developer's own data is never touched.
 */

const ADMIN_URL =
  process.env.DATABASE_URL_MAINTENANCE ?? "postgres://stopgap:stopgap@localhost:5433/stopgap";
const SCRATCH_DB = "stopgap_migration_test";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface JournalEntry {
  tag: string;
}

/** Migration tags in journal order — the same order `pnpm db:migrate` applies them in. */
async function migrationTags(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(resolve(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((e) => e.tag);
}

/**
 * Apply one migration file. Split on drizzle's `--> statement-breakpoint` marker — the same
 * separator drizzle's own migrator uses — and run each chunk in simple-query mode, which is what
 * lets a chunk containing a `DO $$ … $$` block (0013 creates the maintenance role inside one) go
 * through unmodified.
 */
async function applyMigration(sql: postgres.Sql, tag: string): Promise<void> {
  const text = await readFile(resolve(MIGRATIONS_DIR, `${tag}.sql`), "utf8");
  for (const chunk of text.split("--> statement-breakpoint")) {
    const trimmed = chunk.trim();
    if (trimmed) await sql.unsafe(trimmed);
  }
}

/** Rows seeded BEFORE 0013 — i.e. through a schema with no `org_id` anywhere. */
const SEEDED = {
  caseId: "eeee0001-0000-0000-0000-000000000001",
  protocolId: "eeee0002-0000-0000-0000-000000000002",
  auditActions: ["case.detected", "case.assessed", "case.protocol_drafted"],
};
const LEGACY_SHADOW_CORPUS = "legacy-migration-0024-corpus";

let admin: postgres.Sql;
let scratch: postgres.Sql;

beforeAll(async () => {
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => undefined });
  // Dropped first so a previous crashed run cannot make this one pass or fail for the wrong reason.
  await admin.unsafe(`drop database if exists ${SCRATCH_DB}`);
  await admin.unsafe(`create database ${SCRATCH_DB}`);
  scratch = postgres(withDatabase(ADMIN_URL, SCRATCH_DB), { max: 2, onnotice: () => undefined });

  const tags = await migrationTags();
  const boundary = tags.findIndex((t) => t.startsWith("0013"));
  if (boundary < 1)
    throw new Error("migrations.e2e: could not locate migration 0013 in the journal");
  const replayBoundary = tags.findIndex((t) => t.startsWith("0024"));
  if (replayBoundary <= boundary)
    throw new Error("migrations.e2e: could not locate migration 0024 after multi-tenancy");

  // --- everything BEFORE multi-tenancy ------------------------------------------------------
  for (const tag of tags.slice(0, boundary)) await applyMigration(scratch, tag);

  // Rows written by a deployment that predates organizations entirely: no `org_id` column exists
  // yet, so these inserts CANNOT name one. That is the whole point — the backfill has to derive it.
  await scratch`insert into cases (id, workflow_id, key, generic_name, source, source_id, status)
                values (${SEEDED.caseId}, 'case-legacy-heparin', 'legacy-heparin', 'Heparin',
                        'openfda', 'legacy-src-1', 'monitoring')`;
  await scratch`insert into protocols (id, key, title)
                values (${SEEDED.protocolId}, 'legacy-heparin', 'Legacy heparin protocol')`;

  // A real `v1` hash chain, computed with the SAME function the application uses. Hand-chaining it
  // here rather than calling `appendAudit` is deliberate: `appendAudit` writes today's schema (it
  // requires an `orgId`), and the row shape under test is specifically the one that existed before
  // that column did.
  let prev = GENESIS_HASH;
  for (const action of SEEDED.auditActions) {
    const detail = { note: `legacy ${action}` };
    const hash = computeAuditHash("v1", prev, {
      caseId: SEEDED.caseId,
      actor: "system",
      action,
      detail,
    });
    await scratch`insert into audit_log (case_id, actor, action, detail, prev_hash, hash, scheme, run_id, event_key)
                  values (${SEEDED.caseId}, 'system', ${action}, ${JSON.stringify(detail)}::jsonb,
                          ${prev}, ${hash}, 'v1', ${"legacy-run"}, ${action})`;
    prev = hash;
  }

  // --- and now the multi-tenancy migrations -------------------------------------------------
  for (const tag of tags.slice(boundary, replayBoundary)) await applyMigration(scratch, tag);

  // Two legacy replays for the same corpus item on the same UTC day are valid historical evidence
  // under the pre-0024 schema. Seed them immediately before the migration so its backfill is tested
  // against the data shape that made the old ledger non-idempotent.
  await scratch.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${SEED_ORG_ID}, true)`;
    await tx`insert into shadow_runs
      (org_id, corpus_id, key, proposed_severity, baseline_severity, agreement, severity_agreed,
       latency_ms, usd_cost, provider, model_id, ran_at)
      values
        (${SEED_ORG_ID}, ${LEGACY_SHADOW_CORPUS}, 'legacy-shadow-key', 'high', 'high', '1.000', true,
         10, '0', 'ollama', 'mistral', '2026-07-31T10:00:00Z'),
        (${SEED_ORG_ID}, ${LEGACY_SHADOW_CORPUS}, 'legacy-shadow-key', 'high', 'high', '1.000', true,
         11, '0', 'ollama', 'mistral', '2026-07-31T11:00:00Z'),
        (${SEED_ORG_ID}, 'legacy-migration-0024-other-day', 'legacy-shadow-key', 'high', 'high', '1.000', true,
         12, '0', 'ollama', 'mistral', '2026-07-30T11:00:00Z')`;
  });

  for (const tag of tags.slice(replayBoundary)) await applyMigration(scratch, tag);
});

afterAll(async () => {
  await scratch?.end({ timeout: 5 });
  await admin?.unsafe(`drop database if exists ${SCRATCH_DB}`);
  await admin?.end({ timeout: 5 });
});

describe("migrations 0013/0014 against a database that already had rows", () => {
  it("preserves every pre-existing row", async () => {
    // Read unscoped as the OWNER, which 0013 does not exempt (`FORCE ROW LEVEL SECURITY`), so the
    // policies apply and `app.current_org` is unset — hence the explicit scope on each read below.
    const counts = await scratch`select
        (select count(*) from cases) as cases,
        (select count(*) from protocols) as protocols,
        (select count(*) from audit_log) as audit_log`.then((r) => r[0]);
    // Zero here would mean the policies are filtering, not that the rows are gone — which is why
    // the per-row assertions below run inside an explicit org scope rather than trusting this.
    expect(counts).toBeDefined();

    const rows = await scratch.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${SEED_ORG_ID}, true)`;
      return {
        cases: await tx`select id, org_id from cases`,
        protocols: await tx`select id, org_id from protocols`,
        audit: await tx`select id, org_id, action from audit_log order by id`,
      };
    });
    expect(rows.cases).toHaveLength(1);
    expect(rows.protocols).toHaveLength(1);
    expect(rows.audit).toHaveLength(SEEDED.auditActions.length);
    expect(rows.audit.map((r) => r.action)).toEqual(SEEDED.auditActions);
  });

  it("backfills every row into the SEED org, with none left unattributed", async () => {
    const rows = await scratch.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${SEED_ORG_ID}, true)`;
      return {
        cases: await tx`select org_id from cases`,
        protocols: await tx`select org_id from protocols`,
        audit: await tx`select org_id from audit_log`,
      };
    });
    for (const set of [rows.cases, rows.protocols, rows.audit]) {
      expect(set.length).toBeGreaterThan(0);
      for (const row of set) expect(row.org_id).toBe(SEED_ORG_ID);
    }
  });

  it("leaves the pre-migration audit chain VERIFIABLE across the 0013 boundary", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. `v1` hashes a fixed, frozen payload that does not include
    // `org_id`, so adding the column cannot change what those rows hash to — which is exactly why
    // the backfill is safe and why `v1`–`v3` byte layouts must never be "tidied up" to include
    // later fields. If this ever goes red, every historical entry in every deployment has become
    // permanently unverifiable and the chain is reporting tampering that did not happen.
    // The scope is established through DRIZZLE'S transaction, not postgres.js's, and the two are
    // not interchangeable here. `drizzle(client)` reads `client.options.parsers` when it builds a
    // session; a postgres.js TRANSACTION handle is a tagged-template function with no `.options`
    // on it, so wrapping one threw `Cannot read properties of undefined (reading 'parsers')` before
    // a single row was read — the test was failing on its own scaffolding, not on the chain.
    // Driving it from a drizzle instance over the POOL and opening the transaction with
    // `.transaction()` also makes this the same shape production uses (`withOrgDb`).
    const scratchDb = drizzle(scratch, { schema });
    const result = await scratchDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.current_org', ${SEED_ORG_ID}, true)`);
      return verifyAuditChain(tx as unknown as Db, SEED_ORG_ID);
    });
    expect(result.ok).toBe(true);
    expect(result.brokenAtId).toBeUndefined();
  });

  it("creates the second organization, so the deployment has two tenants after a plain migrate", async () => {
    const orgs = await scratch`select slug from organizations order by created_at`;
    expect(orgs.map((o) => o.slug)).toEqual(expect.arrayContaining(["stopgap", "riverside"]));
  });

  it("promotes (org_id, key) on cases to a UNIQUE index (migration 0014)", async () => {
    const [idx] = await scratch`select indexdef from pg_indexes
                                where tablename = 'cases' and indexname = 'cases_key_uq'`;
    expect(idx?.indexdef).toContain("UNIQUE");
    // And the non-unique predecessor is gone rather than left behind as a duplicate write cost.
    const leftovers = await scratch`select 1 from pg_indexes
                                    where tablename = 'cases' and indexname = 'cases_key_idx'`;
    expect(leftovers).toHaveLength(0);
  });

  it("backfills legacy shadow days without deleting same-day duplicate evidence", async () => {
    const rows = await scratch.begin(async (tx) => {
      await tx`select set_config('app.current_org', ${SEED_ORG_ID}, true)`;
      return tx`select replay_day, ran_at
                from shadow_runs
                where corpus_id = ${LEGACY_SHADOW_CORPUS}
                order by ran_at`;
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.replay_day).toBe("2026-07-31");
    expect(rows[1]?.replay_day).toBeNull();

    const [index] = await scratch`select indexdef from pg_indexes
                                  where tablename = 'shadow_runs'
                                    and indexname = 'shadow_runs_org_corpus_day_uq'`;
    expect(index?.indexdef).toContain("WHERE");
    expect(index?.indexdef).toContain("replay_day");
    expect(index?.indexdef.toLowerCase()).toContain("is not null");
  });

  /**
   * Tickets 06 and 17 — these tables arrive POLICED, applied as the role a deployment migrates as.
   *
   * The whole migration set already ran above, as the owner, against a throwaway database. What
   * this adds is the assertion that the hand-written halves of 0015 and 0022 ran too: a table
   * created without its policy is not a missing feature, it is a table every tenant can read in
   * full, and the DDL would succeed either way.
   *
   * `connector_runs` is here rather than only in `rls.e2e.test.ts` because that suite runs as
   * `stopgap_app`, which the policy applies to whether or not it is FORCED. Only a check under the
   * OWNER can tell an enabled policy from a forced one, and this connection is the owner.
   */
  it("creates the policed tables with row-level security FORCED and a policy on each", async () => {
    for (const table of ["risk_signals", "risk_score_snapshots", "connector_runs"]) {
      const [rel] = await scratch`select relrowsecurity, relforcerowsecurity
                                  from pg_class where relname = ${table}`;
      expect(rel?.relrowsecurity, `${table} RLS enabled`).toBe(true);
      // FORCE is what makes the policy apply to the OWNER — which is what this very connection is.
      // Without it the isolation suite passes while nothing is enforced.
      expect(rel?.relforcerowsecurity, `${table} RLS forced`).toBe(true);
      const policies = await scratch`select policyname from pg_policies where tablename = ${table}`;
      expect(policies.map((p) => p.policyname)).toEqual([`${table}_org_isolation`]);
    }
  });
});
