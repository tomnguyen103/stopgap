import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * ============================================================================================
 * THESE TESTS REQUIRE A LIVE POSTGRES. THEY ARE NOT PART OF `pnpm gate` / `pnpm test`.
 * ============================================================================================
 *
 * Cross-tenant isolation (PHASE6 §6.5) is enforced by Postgres row-level security, so proving it
 * needs Postgres — there is nothing here a mock could honestly assert. The root `vitest.config.ts`
 * excludes `**\/*.e2e.test.ts` from the default run, so `pnpm test` never reaches for a database.
 *
 * To run them:
 *
 *   1. `pnpm infra:up && pnpm db:migrate`      (a database with migrations 0013 and 0014 applied)
 *   2. `docker compose up` already created `stopgap_app` — the non-superuser application role RLS
 *      actually applies to (see deploy/postgres/app-role.sql). Point the two urls at the two roles:
 *
 *        DATABASE_URL=postgres://stopgap_app:stopgap_app@localhost:5433/stopgap \
 *        DATABASE_URL_MAINTENANCE=postgres://stopgap:stopgap@localhost:5433/stopgap \
 *          pnpm test:rls
 *
 * BOTH urls matter, and they are testing different halves of the design. `DATABASE_URL` must name a
 * role the policies apply to, and `beforeAll` REFUSES TO RUN if it does not: the compose default
 * `stopgap` is a superuser, a superuser bypasses every policy unconditionally (`FORCE ROW LEVEL
 * SECURITY` does not apply to it), and running this suite as that role would produce a green board
 * proving nothing at all — a test that reports isolation is working precisely when it is not.
 * `DATABASE_URL_MAINTENANCE` must name the BYPASSRLS role, because since migration 0014
 * `audit_anchors` accepts no writes from a tenant connection at all; the anchor fixtures below are
 * written over that connection, which is exactly how anchoring runs in production.
 *
 * What is asserted, once per tenant table:
 *   - a session scoped to org A SELECTing org B's row gets ZERO rows (not an error — RLS filters,
 *     it does not announce);
 *   - the same for an UPDATE and for a DELETE: zero rows AFFECTED, with org B's row still intact
 *     afterwards. §6.5's bullet says "selects/updates", and a read policy is not a write guarantee;
 *   - an INSERT carrying a foreign `org_id` is REFUSED by the policy's WITH CHECK;
 *   - a session with `app.current_org` unset sees NOTHING (fail-closed, per the two-argument
 *     `current_setting(..., true)` returning NULL).
 *
 * Plus the per-org audit chain, and `audit_anchors`' deliberately asymmetric SELECT-only policy.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://stopgap:stopgap@localhost:5433/stopgap";

const ORG_A = "aaaaaaaa-0000-0000-0000-00000000000a";
const ORG_B = "bbbbbbbb-0000-0000-0000-00000000000b";

/** Deterministic ids so a re-run cleans up after a previous crashed one. */
const ID = {
  caseA: "aaaa0001-0000-0000-0000-000000000001",
  caseB: "bbbb0001-0000-0000-0000-000000000001",
  userA: "aaaa0002-0000-0000-0000-000000000002",
  userB: "bbbb0002-0000-0000-0000-000000000002",
  protocolA: "aaaa0003-0000-0000-0000-000000000003",
  protocolB: "bbbb0003-0000-0000-0000-000000000003",
  versionA: "aaaa0004-0000-0000-0000-000000000004",
  versionB: "bbbb0004-0000-0000-0000-000000000004",
  shadowA: "aaaa0005-0000-0000-0000-000000000005",
  shadowB: "bbbb0005-0000-0000-0000-000000000005",
  demoA: "aaaa0006-0000-0000-0000-000000000006",
  demoB: "bbbb0006-0000-0000-0000-000000000006",
  ackA: "aaaa0007-0000-0000-0000-000000000007",
  ackB: "bbbb0007-0000-0000-0000-000000000007",
  keyA: "aaaa0008-0000-0000-0000-000000000008",
  keyB: "bbbb0008-0000-0000-0000-000000000008",
  // Ticket 06 — normalized signals and their score snapshots.
  signalA: "aaaa0009-0000-0000-0000-000000000009",
  signalB: "bbbb0009-0000-0000-0000-000000000009",
  scoreA: "aaaa0010-0000-0000-0000-000000000010",
  scoreB: "bbbb0010-0000-0000-0000-000000000010",
  // Ticket 09 — the evidence trail behind a signal.
  evidenceA: "aaaa0011-0000-0000-0000-000000000011",
  evidenceB: "bbbb0011-0000-0000-0000-000000000011",
  // Ticket 12 — alert rules and the events they produce.
  ruleA: "aaaa0012-0000-0000-0000-000000000012",
  ruleB: "bbbb0012-0000-0000-0000-000000000012",
  alertA: "aaaa0013-0000-0000-0000-000000000013",
  alertB: "bbbb0013-0000-0000-0000-000000000013",
  // Ticket 13 — the daily brief.
  briefA: "aaaa0011-0000-0000-0000-000000000011",
  briefB: "bbbb0011-0000-0000-0000-000000000011",
} as const;

/**
 * The MAINTENANCE connection (PHASE6 §6.5) — a role holding BYPASSRLS, the one anchoring genuinely
 * runs as. Needed here because migration 0014 gives `audit_anchors` a SELECT-only policy: with no
 * write policy, the application role cannot insert an anchor AT ALL, which is the point. Writing
 * the anchor fixtures on this connection is therefore not a convenience, it is the production
 * arrangement — and it means the anchor tests below prove the split rather than assuming it.
 */
const MAINTENANCE_URL =
  process.env.DATABASE_URL_MAINTENANCE ?? "postgres://stopgap:stopgap@localhost:5433/stopgap";

const db = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
const maint = postgres(MAINTENANCE_URL, { max: 2, onnotice: () => undefined });

/** Run `fn` in a transaction scoped to one tenant — the production `withOrgDb` shape. */
async function asOrg<T>(
  orgId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return db.begin(async (tx) => {
    await tx`select set_config('app.current_org', ${orgId}, true)`;
    return fn(tx);
  }) as Promise<T>;
}

/** Run `fn` with NO tenant scope — what a forgotten `withOrgDb` produces. */
async function unscoped<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return db.begin((tx) => fn(tx)) as Promise<T>;
}

/** Insert the whole fixture for one org, from inside that org's own scope. */
async function seedOrg(
  orgId: string,
  ids: {
    caseId: string;
    userId: string;
    protocolId: string;
    versionId: string;
    shadowId: string;
    demoId: string;
    ackId: string;
    keyId: string;
    signalId: string;
    scoreId: string;
    evidenceId: string;
    ruleId: string;
    alertId: string;
    briefId: string;
  },
  suffix: string,
) {
  await asOrg(orgId, async (tx) => {
    await tx`insert into cases (id, org_id, workflow_id, key, generic_name, source, source_id)
             values (${ids.caseId}, ${orgId}, ${"case-rls-" + suffix}, ${"rls-" + suffix},
                     ${"RLS " + suffix}, 'openfda', ${"src-" + suffix})`;
    await tx`insert into users (id, org_id, oidc_subject, email, display_name)
             values (${ids.userId}, ${orgId}, ${"rls-sub-" + suffix}, ${"rls-" + suffix + "@test"}, 'RLS User')`;
    await tx`insert into protocols (id, org_id, key, title)
             values (${ids.protocolId}, ${orgId}, ${"rls-" + suffix}, ${"RLS protocol " + suffix})`;
    await tx`insert into protocol_versions (id, org_id, protocol_id, version, body, authored_by)
             values (${ids.versionId}, ${orgId}, ${ids.protocolId}, 1, 'body', 'agent')`;
    await tx`insert into shadow_runs (id, org_id, corpus_id, key, proposed_severity, proposed_alternatives,
                                      baseline_severity, baseline_alternatives, agreement, severity_agreed,
                                      latency_ms, usd_cost, provider, model_id)
             values (${ids.shadowId}, ${orgId}, ${"corpus-" + suffix}, ${"rls-" + suffix}, 'high', '[]'::jsonb,
                     'high', '[]'::jsonb, 1.0, true, 10, 0.001, 'test', 'test-model')`;
    await tx`insert into demo_runs (id, org_id, key) values (${ids.demoId}, ${orgId}, ${"rls-" + suffix})`;
    await tx`insert into acknowledgments (id, org_id, case_id, user_id, step)
             values (${ids.ackId}, ${orgId}, ${ids.caseId}, ${ids.userId}, 0)`;
    await tx`insert into api_keys (id, org_id, name, key_hash, key_prefix)
             values (${ids.keyId}, ${orgId}, ${"rls-" + suffix}, ${"hash-" + suffix}, 'sk_live_rlsxxx')`;
    await tx`insert into audit_log (org_id, case_id, actor, action, prev_hash, hash, run_id, event_key)
             values (${orgId}, ${ids.caseId}, 'system', 'case.detected', ${"0".repeat(64)},
                     ${"h-" + suffix}, ${"run-" + suffix}, 'case.detected')`;

    // Ticket 06 — one signal and one score snapshot, seeded from inside this org's own scope so
    // the seed itself exercises WITH CHECK before any isolation assertion runs.
    await tx`insert into risk_signals (id, org_id, source, source_id, risk_domain, entity_type,
                                       entity_identifier, title, summary, severity, severity_score,
                                       confidence, observed_at, published_at, last_fetched_at,
                                       staleness, evidence_url, raw, dedupe_key, match_hints)
             values (${ids.signalId}, ${orgId}, 'openfda_shortage', ${"src-" + suffix}, 'shortage',
                     'drug', ${"entity-" + suffix}, ${"Signal " + suffix}, 'summary', 'high', 0.7,
                     0.8, now(), now(), now(), 'fresh', 'https://example.test/evidence',
                     '{}'::jsonb, ${orgId + ":openfda_shortage:src-" + suffix},
                     '{"ndcs":[],"rxcuis":[],"names":[]}'::jsonb)`;
    await tx`insert into risk_score_snapshots (id, org_id, signal_id, score, band, components,
                                               reachable_max, scorer_version)
             values (${ids.scoreId}, ${orgId}, ${ids.signalId}, 42.5, 'moderate', '{}'::jsonb,
                     65, 'test-1')`;
    await tx`insert into signal_evidence (id, org_id, signal_id, type, source, source_id,
                                          origin_url, content_hash, captured_at)
             values (${ids.evidenceId}, ${orgId}, ${ids.signalId}, 'provider_record',
                     'openfda_shortage', ${"src-" + suffix}, 'https://example.test/evidence',
                     ${"hash-" + suffix}, now())`;
    await tx`insert into alert_rules (id, org_id, name, min_severity, cooldown_minutes, channels)
             values (${ids.ruleId}, ${orgId}, ${"rule-" + suffix}, 'high', 60,
                     '["email"]'::jsonb)`;
    await tx`insert into alert_events (id, org_id, rule_id, outcome, matched_count, matched_keys,
                                       deliveries, idempotency_key, fired_at)
             values (${ids.alertId}, ${orgId}, ${ids.ruleId}, 'fired', 1, '[]'::jsonb, '[]'::jsonb,
                     ${"idem-" + suffix}, now())`;

    // Ticket 13 — one daily brief, seeded from inside this org's own scope for the same reason.
    await tx`insert into daily_briefs (id, org_id, brief_date, headline, changes, newly_at_risk,
                                       needs_review, signal_keys)
             values (${ids.briefId}, ${orgId}, '2026-01-01', ${"Brief " + suffix}, '[]'::jsonb,
                     '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`;
  });
}

/**
 * One entry per TENANT table: how to read a specific row by id (or by a distinguishing column),
 * and how to attempt an insert under a given org label. Every table in this list must appear, or
 * a table added later silently ships with no isolation test.
 */
interface TenantTable {
  name: string;
  /** Rows of this table belonging to org B, addressed WITHOUT any org predicate. */
  readOthers: (tx: postgres.TransactionSql) => Promise<postgres.RowList<postgres.Row[]>>;
  /** Insert a fresh row stamped with `orgLabel`; used to prove WITH CHECK refuses a foreign org. */
  insertAs: (tx: postgres.TransactionSql, orgLabel: string) => Promise<unknown>;
  /** Every row of the table, unfiltered — for the unscoped-session test. */
  readAll: (tx: postgres.TransactionSql) => Promise<postgres.RowList<postgres.Row[]>>;
  /**
   * Attempt to UPDATE org B's row WITHOUT any org predicate, returning the affected rows.
   * §6.5's test bullet says "selects/updates", and the two are different questions: a SELECT policy
   * hiding a row is not the same guarantee as a WRITE being unable to reach it. `USING` governs
   * both, but only an actual UPDATE proves it.
   */
  updateOthers: (tx: postgres.TransactionSql) => Promise<postgres.RowList<postgres.Row[]>>;
  /** Attempt to DELETE org B's row WITHOUT any org predicate, returning the affected rows. */
  deleteOthers: (tx: postgres.TransactionSql) => Promise<postgres.RowList<postgres.Row[]>>;
}

const TENANT_TABLES: TenantTable[] = [
  {
    name: "signal_evidence",
    readOthers: (tx) => tx`select id from signal_evidence where id = ${ID.evidenceB}`,
    insertAs: (tx, org) =>
      tx`insert into signal_evidence (org_id, signal_id, type, source, source_id, origin_url,
                                      content_hash, captured_at)
         values (${org}, ${ID.signalA}, 'provider_record', 'openfda_shortage',
                 ${"x-" + org.slice(0, 4)}, 'https://example.test/x', ${"h-" + org.slice(0, 4)},
                 now())`,
    readAll: (tx) => tx`select id from signal_evidence`,
    updateOthers: (tx) =>
      tx`update signal_evidence set origin_url = 'hijacked' where id = ${ID.evidenceB} returning id`,
    deleteOthers: (tx) => tx`delete from signal_evidence where id = ${ID.evidenceB} returning id`,
  },
  {
    name: "alert_rules",
    readOthers: (tx) => tx`select id from alert_rules where id = ${ID.ruleB}`,
    insertAs: (tx, org) =>
      tx`insert into alert_rules (org_id, name, min_severity, cooldown_minutes, channels)
         values (${org}, ${"x-" + org.slice(0, 4)}, 'high', 60, '["email"]'::jsonb)`,
    readAll: (tx) => tx`select id from alert_rules`,
    updateOthers: (tx) =>
      tx`update alert_rules set enabled = false where id = ${ID.ruleB} returning id`,
    deleteOthers: (tx) => tx`delete from alert_rules where id = ${ID.ruleB} returning id`,
  },
  {
    name: "alert_events",
    readOthers: (tx) => tx`select id from alert_events where id = ${ID.alertB}`,
    insertAs: (tx, org) =>
      // The org's OWN rule, so a refusal is the POLICY refusing and not the composite foreign key
      // complaining that org B has no rule `ruleA`. Testing the wrong constraint passes for the
      // wrong reason.
      tx`insert into alert_events (org_id, rule_id, outcome, matched_count, matched_keys,
                                   deliveries, idempotency_key, fired_at)
         values (${org}, ${org === ORG_A ? ID.ruleA : ID.ruleB}, 'fired', 1, '[]'::jsonb,
                 '[]'::jsonb, ${"x-" + org.slice(0, 4)}, now())`,
    readAll: (tx) => tx`select id from alert_events`,
    updateOthers: (tx) =>
      tx`update alert_events set outcome = 'hijacked' where id = ${ID.alertB} returning id`,
    deleteOthers: (tx) => tx`delete from alert_events where id = ${ID.alertB} returning id`,
  },

  {
    name: "risk_signals",
    readOthers: (tx) => tx`select id from risk_signals where id = ${ID.signalB}`,
    insertAs: (tx, org) =>
      tx`insert into risk_signals (org_id, source, source_id, risk_domain, entity_type,
                                   entity_identifier, title, summary, severity, severity_score,
                                   confidence, observed_at, published_at, last_fetched_at,
                                   staleness, evidence_url, raw, dedupe_key, match_hints)
         values (${org}, 'openfda_shortage', ${"x-" + org.slice(0, 4)}, 'shortage', 'drug', 'x',
                 'X', 'x', 'low', 0.1, 0.8, now(), now(), now(), 'fresh', 'https://example.test/x',
                 '{}'::jsonb, ${org + ":openfda_shortage:x-" + org.slice(0, 4)},
                 '{"ndcs":[],"rxcuis":[],"names":[]}'::jsonb)`,
    readAll: (tx) => tx`select id from risk_signals`,
    updateOthers: (tx) =>
      tx`update risk_signals set title = 'hijacked' where id = ${ID.signalB} returning id`,
    deleteOthers: (tx) => tx`delete from risk_signals where id = ${ID.signalB} returning id`,
  },
  {
    name: "risk_score_snapshots",
    readOthers: (tx) => tx`select id from risk_score_snapshots where id = ${ID.scoreB}`,
    // The snapshot points at the org's OWN signal. `risk_score_snapshots` FKs `signal_id` alone,
    // and referential integrity checks bypass RLS, so a fixture pairing one org's id with another
    // org's signal would insert cleanly — writing a cross-tenant pairing into the suite that is
    // supposed to prove tenants stay apart. What this row must isolate is the `org_id` column.
    insertAs: (tx, org) =>
      tx`insert into risk_score_snapshots (org_id, signal_id, score, band, components,
                                           reachable_max, scorer_version)
         values (${org}, ${org === ORG_A ? ID.signalA : ID.signalB}, 1, 'low', '{}'::jsonb, 65,
                 ${"v-" + org.slice(0, 4)})`,
    readAll: (tx) => tx`select id from risk_score_snapshots`,
    updateOthers: (tx) =>
      tx`update risk_score_snapshots set band = 'hijacked' where id = ${ID.scoreB} returning id`,
    deleteOthers: (tx) => tx`delete from risk_score_snapshots where id = ${ID.scoreB} returning id`,
  },
  {
    name: "daily_briefs",
    readOthers: (tx) => tx`select id from daily_briefs where id = ${ID.briefB}`,
    insertAs: (tx, org) =>
      tx`insert into daily_briefs (org_id, brief_date, headline, changes, newly_at_risk,
                                   needs_review, signal_keys)
         values (${org}, '2026-01-02', 'X', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
    readAll: (tx) => tx`select id from daily_briefs`,
    updateOthers: (tx) =>
      tx`update daily_briefs set headline = 'hijacked' where id = ${ID.briefB} returning id`,
    deleteOthers: (tx) => tx`delete from daily_briefs where id = ${ID.briefB} returning id`,
  },

  {
    name: "cases",
    readOthers: (tx) => tx`select id from cases where id = ${ID.caseB}`,
    insertAs: (tx, org) =>
      tx`insert into cases (org_id, workflow_id, key, generic_name, source, source_id)
         values (${org}, ${"case-x-" + org.slice(0, 4)}, 'x', 'X', 'openfda', 'sx')`,
    readAll: (tx) => tx`select id from cases`,
    updateOthers: (tx) =>
      tx`update cases set last_note = 'hijacked' where id = ${ID.caseB} returning id`,
    deleteOthers: (tx) => tx`delete from cases where id = ${ID.caseB} returning id`,
  },
  {
    name: "protocols",
    readOthers: (tx) => tx`select id from protocols where id = ${ID.protocolB}`,
    insertAs: (tx, org) =>
      tx`insert into protocols (org_id, key, title) values (${org}, ${"x-" + org.slice(0, 4)}, 'X')`,
    readAll: (tx) => tx`select id from protocols`,
    updateOthers: (tx) =>
      tx`update protocols set title = 'hijacked' where id = ${ID.protocolB} returning id`,
    deleteOthers: (tx) => tx`delete from protocols where id = ${ID.protocolB} returning id`,
  },
  {
    name: "protocol_versions",
    readOthers: (tx) => tx`select id from protocol_versions where id = ${ID.versionB}`,
    insertAs: (tx, org) =>
      tx`insert into protocol_versions (org_id, protocol_id, version, body, authored_by)
         values (${org}, ${ID.protocolA}, 99, 'x', 'agent')`,
    readAll: (tx) => tx`select id from protocol_versions`,
    updateOthers: (tx) =>
      tx`update protocol_versions set body = 'hijacked' where id = ${ID.versionB} returning id`,
    deleteOthers: (tx) => tx`delete from protocol_versions where id = ${ID.versionB} returning id`,
  },
  {
    name: "shadow_runs",
    readOthers: (tx) => tx`select id from shadow_runs where id = ${ID.shadowB}`,
    insertAs: (tx, org) =>
      tx`insert into shadow_runs (org_id, corpus_id, key, proposed_severity, baseline_severity,
                                  agreement, severity_agreed, latency_ms, usd_cost, provider, model_id)
         values (${org}, 'cx', 'x', 'high', 'high', 1.0, true, 1, 0.001, 'test', 'm')`,
    readAll: (tx) => tx`select id from shadow_runs`,
    updateOthers: (tx) =>
      tx`update shadow_runs set model_id = 'hijacked' where id = ${ID.shadowB} returning id`,
    deleteOthers: (tx) => tx`delete from shadow_runs where id = ${ID.shadowB} returning id`,
  },
  {
    name: "audit_log",
    readOthers: (tx) => tx`select id from audit_log where org_id = ${ORG_B}`,
    insertAs: (tx, org) =>
      tx`insert into audit_log (org_id, actor, action, prev_hash, hash, run_id, event_key)
         values (${org}, 'system', 'x', ${"0".repeat(64)}, ${"hx-" + org.slice(0, 4)}, 'rx', 'x')`,
    readAll: (tx) => tx`select id from audit_log`,
    updateOthers: (tx) =>
      tx`update audit_log set hash = 'hijacked' where org_id = ${ORG_B} returning id`,
    deleteOthers: (tx) => tx`delete from audit_log where org_id = ${ORG_B} returning id`,
  },
  {
    name: "users",
    readOthers: (tx) => tx`select id from users where id = ${ID.userB}`,
    insertAs: (tx, org) =>
      tx`insert into users (org_id, oidc_subject) values (${org}, ${"sub-x-" + org.slice(0, 4)})`,
    readAll: (tx) => tx`select id from users`,
    updateOthers: (tx) =>
      tx`update users set display_name = 'hijacked' where id = ${ID.userB} returning id`,
    deleteOthers: (tx) => tx`delete from users where id = ${ID.userB} returning id`,
  },
  {
    name: "demo_runs",
    readOthers: (tx) => tx`select id from demo_runs where id = ${ID.demoB}`,
    insertAs: (tx, org) => tx`insert into demo_runs (org_id, key) values (${org}, 'x')`,
    readAll: (tx) => tx`select id from demo_runs`,
    updateOthers: (tx) =>
      tx`update demo_runs set key = 'hijacked' where id = ${ID.demoB} returning id`,
    deleteOthers: (tx) => tx`delete from demo_runs where id = ${ID.demoB} returning id`,
  },
  {
    name: "acknowledgments",
    readOthers: (tx) => tx`select id from acknowledgments where id = ${ID.ackB}`,
    insertAs: (tx, org) =>
      tx`insert into acknowledgments (org_id, case_id, user_id, step)
         values (${org}, ${ID.caseA}, ${ID.userA}, 99)`,
    readAll: (tx) => tx`select id from acknowledgments`,
    updateOthers: (tx) =>
      tx`update acknowledgments set step = 42 where id = ${ID.ackB} returning id`,
    deleteOthers: (tx) => tx`delete from acknowledgments where id = ${ID.ackB} returning id`,
  },
  {
    name: "api_keys",
    readOthers: (tx) => tx`select id from api_keys where id = ${ID.keyB}`,
    insertAs: (tx, org) =>
      tx`insert into api_keys (org_id, name, key_hash, key_prefix)
         values (${org}, 'x', ${"hash-x-" + org.slice(0, 4)}, 'sk_live_xxxxxx')`,
    readAll: (tx) => tx`select id from api_keys`,
    updateOthers: (tx) =>
      tx`update api_keys set revoked_at = now() where id = ${ID.keyB} returning id`,
    deleteOthers: (tx) => tx`delete from api_keys where id = ${ID.keyB} returning id`,
  },
];

beforeAll(async () => {
  const [role] = await db<{ rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]>`
    select rolname, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
  if (!role) throw new Error("rls.e2e: could not read the current role from pg_roles");
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `rls.e2e: connected as "${role.rolname}", which is ${role.rolsuper ? "a SUPERUSER" : "BYPASSRLS"}. ` +
        "Policies do not apply to it, so this suite would pass without testing anything. " +
        "Point DATABASE_URL at a plain application role (see the header of this file).",
    );
  }

  // `organizations` carries no RLS policy by design (a session must resolve its own org before
  // `app.current_org` can be set), so the tenants are created on an ordinary connection.
  await db`insert into organizations (id, slug, name) values (${ORG_A}, 'rls-org-a', 'RLS Org A')
           on conflict (id) do nothing`;
  await db`insert into organizations (id, slug, name) values (${ORG_B}, 'rls-org-b', 'RLS Org B')
           on conflict (id) do nothing`;

  await seedOrg(
    ORG_A,
    {
      caseId: ID.caseA,
      userId: ID.userA,
      protocolId: ID.protocolA,
      versionId: ID.versionA,
      shadowId: ID.shadowA,
      demoId: ID.demoA,
      ackId: ID.ackA,
      keyId: ID.keyA,
      signalId: ID.signalA,
      scoreId: ID.scoreA,
      evidenceId: ID.evidenceA,
      ruleId: ID.ruleA,
      alertId: ID.alertA,
      briefId: ID.briefA,
    },
    "a",
  );
  await seedOrg(
    ORG_B,
    {
      caseId: ID.caseB,
      userId: ID.userB,
      protocolId: ID.protocolB,
      versionId: ID.versionB,
      shadowId: ID.shadowB,
      demoId: ID.demoB,
      ackId: ID.ackB,
      keyId: ID.keyB,
      signalId: ID.signalB,
      scoreId: ID.scoreB,
      evidenceId: ID.evidenceB,
      ruleId: ID.ruleB,
      alertId: ID.alertB,
      briefId: ID.briefB,
    },
    "b",
  );
});

afterAll(async () => {
  // Each org tears down its own rows through its own scope — the policies apply to DELETE too.
  for (const org of [ORG_A, ORG_B]) {
    await asOrg(org, async (tx) => {
      await tx`delete from audit_log where org_id = ${org}`;
      await tx`delete from acknowledgments where org_id = ${org}`;
      await tx`delete from protocol_versions where org_id = ${org}`;
      await tx`delete from protocols where org_id = ${org}`;
      await tx`delete from shadow_runs where org_id = ${org}`;
      await tx`delete from demo_runs where org_id = ${org}`;
      await tx`delete from api_keys where org_id = ${org}`;
      await tx`delete from cases where org_id = ${org}`;
      await tx`delete from users where org_id = ${org}`;
      // Snapshots first: they FK the signal they scored.
      await tx`delete from signal_evidence where org_id = ${org}`;
      // Events first: they FK the rule that produced them.
      await tx`delete from alert_events where org_id = ${org}`;
      await tx`delete from alert_rules where org_id = ${org}`;
      await tx`delete from daily_briefs where org_id = ${org}`;
      await tx`delete from risk_score_snapshots where org_id = ${org}`;
      await tx`delete from risk_signals where org_id = ${org}`;
    });
  }
  // `audit_anchors` takes no writes from a tenant connection at all (migration 0014), so its rows
  // go over `maint` — and they are torn down HERE rather than at the end of each anchor test. Inline
  // cleanup only runs when the test reaches it: an assertion that fails mid-test leaves the rows
  // behind, and unlike every other fixture in this file those rows have no deterministic id to
  // collide with (`audit_anchors.id` is a `bigserial`), so the next run silently sees four anchors
  // where it expects two and fails somewhere unrelated. Before the organizations delete: the FK.
  await maint`delete from audit_anchors where org_id in (${ORG_A}, ${ORG_B})`;
  await db`delete from organizations where id in (${ORG_A}, ${ORG_B})`;
  await db.end({ timeout: 5 });
  await maint.end({ timeout: 5 });
});

describe("cross-tenant SELECT returns zero rows", () => {
  for (const table of TENANT_TABLES) {
    it(`${table.name}: org A cannot see org B's row`, async () => {
      // Note what is NOT asserted: an error. RLS filters silently, so the honest expectation is
      // an empty result — which is also why the app layer keeps its own explicit org predicate
      // (an empty page is a bug someone reports; a silent pass-through is not).
      const rows = await asOrg(ORG_A, (tx) => table.readOthers(tx));
      expect(rows).toHaveLength(0);
    });

    it(`${table.name}: org B CAN see its own row (the filter is isolation, not breakage)`, async () => {
      const rows = await asOrg(ORG_B, (tx) => table.readOthers(tx));
      expect(rows.length).toBeGreaterThan(0);
    });
  }
});

describe("INSERT with a foreign org_id is refused by WITH CHECK", () => {
  for (const table of TENANT_TABLES) {
    it(`${table.name}: org A cannot write a row labelled org B`, async () => {
      // Postgres raises 42501 ("new row violates row-level security policy"). The write is
      // REFUSED rather than accepted-and-hidden, which matters: an accepted-but-invisible row
      // would let one tenant plant data in another's account and never know it landed.
      await expect(asOrg(ORG_A, (tx) => table.insertAs(tx, ORG_B))).rejects.toMatchObject({
        code: "42501",
      });
    });
  }
});

/**
 * §6.5's test bullet is "a session scoped to org A selects/UPDATES org B rows, gets zero rows /
 * permission denied", and the update half needs its own proof. A SELECT policy that hides a row and
 * a write that cannot reach it are different guarantees, even though `USING` supplies both: a table
 * that had (say) a SELECT-only policy would pass every assertion above while remaining freely
 * writable by any tenant — which is exactly the hole migration 0014 closes on `audit_anchors`.
 *
 * ZERO ROWS AFFECTED, not an error. `USING` filters the rows a statement may see, and an UPDATE or
 * DELETE that matches nothing is a perfectly successful statement that changed nothing. That is the
 * dangerous-looking shape: the attacker's `update … set hash = 'hijacked'` COMMITS, and reports
 * success, having touched nothing. `returning id` is what makes the distinction observable.
 */
describe("cross-tenant UPDATE affects zero rows", () => {
  for (const table of TENANT_TABLES) {
    it(`${table.name}: org A cannot modify org B's row`, async () => {
      const affected = await asOrg(ORG_A, (tx) => table.updateOthers(tx));
      expect(affected).toHaveLength(0);
    });

    it(`${table.name}: org B's row is still intact afterwards`, async () => {
      // The complement, and not a formality: an UPDATE returning zero rows would also be the
      // observable outcome if the row had been deleted by the previous case. This says the row is
      // there and untouched, so "zero rows affected" means isolation and not collateral damage.
      const rows = await asOrg(ORG_B, (tx) => table.readOthers(tx));
      expect(rows.length).toBeGreaterThan(0);
    });
  }
});

describe("cross-tenant DELETE affects zero rows", () => {
  for (const table of TENANT_TABLES) {
    it(`${table.name}: org A cannot delete org B's row`, async () => {
      const affected = await asOrg(ORG_A, (tx) => table.deleteOthers(tx));
      expect(affected).toHaveLength(0);
      // And it really is still there — this is the assertion that would fail catastrophically if a
      // policy were ever relaxed, so it is made explicitly rather than left to the suite's teardown.
      const survivors = await asOrg(ORG_B, (tx) => table.readOthers(tx));
      expect(survivors.length).toBeGreaterThan(0);
    });
  }
});

describe("an unscoped session sees NOTHING (fail-closed)", () => {
  for (const table of TENANT_TABLES) {
    it(`${table.name}: no app.current_org => zero rows, not every row`, async () => {
      // `current_setting('app.current_org', true)` returns NULL when unset, `org_id = NULL` is
      // NULL, and NULL is not TRUE. The direction of that failure is the whole design: a
      // forgotten scope shows an empty page, never another hospital's data.
      const rows = await unscoped((tx) => table.readAll(tx));
      expect(rows).toHaveLength(0);
    });
  }
});

/**
 * ============================================================================================
 * PER-ORG AUDIT CHAIN AND ANCHORING (PHASE6 §6.5 pass 2)
 * ============================================================================================
 *
 * The suites above prove ROW isolation. These prove the two DERIVED structures that pass 1 made
 * per-tenant and pass 2 finished: the hash chain, and the anchors that pin it.
 *
 * Why this needs a live database rather than a unit test: the properties are about what a SCOPED
 * SESSION can observe. "Org A's chain verifies from its own genesis" is only meaningful if org B's
 * rows are actually invisible while it is being verified, and that invisibility is Postgres's job.
 */
describe("the audit chain is per-org", () => {
  it("each org sees only its own chain, so verification is a per-tenant question", async () => {
    const a = await asOrg(
      ORG_A,
      (tx) => tx`select org_id, prev_hash, hash from audit_log order by id`,
    );
    const b = await asOrg(
      ORG_B,
      (tx) => tx`select org_id, prev_hash, hash from audit_log order by id`,
    );
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.every((r) => r.org_id === ORG_A)).toBe(true);
    expect(b.every((r) => r.org_id === ORG_B)).toBe(true);
    // Disjoint: no row appears in both listings, which is what makes "verify org A's chain" a
    // question about org A alone.
    const hashesA = new Set(a.map((r) => r.hash as string));
    expect(b.some((r) => hashesA.has(r.hash as string))).toBe(false);
  });

  it("a new org's first entry chains to GENESIS, not to another tenant's last hash", async () => {
    // Both fixtures were seeded with prev_hash = GENESIS. The point of asserting it here rather
    // than in a unit test is that org B's first row was written while org A already HAD rows: a
    // global chain would have linked it to org A's head, which is the bug per-org chaining fixes.
    const [first] = await asOrg(
      ORG_B,
      (tx) => tx`select prev_hash from audit_log order by id limit 1`,
    );
    expect(first?.prev_hash).toBe("0".repeat(64));
  });

  it("org A cannot append into org B's chain", async () => {
    await expect(
      asOrg(
        ORG_A,
        (tx) => tx`insert into audit_log (org_id, actor, action, prev_hash, hash, run_id, event_key)
                   values (${ORG_B}, 'system', 'x', ${"0".repeat(64)}, 'hijack', 'r', 'x')`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("audit_anchors carry an org (migration 0014)", () => {
  it("has a NOT NULL org_id column", async () => {
    const [col] = await unscoped(
      (tx) => tx`select is_nullable from information_schema.columns
                 where table_name = 'audit_anchors' and column_name = 'org_id'`,
    );
    // If this is missing, migration 0014 has not been applied to the database under test — the
    // suite says so plainly rather than skipping and reporting green.
    expect(col?.is_nullable).toBe("NO");
  });

  /**
   * `audit_anchors` is the one table with an ASYMMETRIC policy (migration 0014): SELECT is scoped
   * like any tenant table, and there is no INSERT/UPDATE/DELETE policy at all, so writes are the
   * maintenance role's alone. That combination is what holds both properties at once — a tenant
   * cannot stop its own history being anchored, and cannot reach anyone else's anchors.
   *
   * Before 0014 the table had NO policy, which was justified only by the first property. The second
   * was simply absent: any org-scoped connection could read, rewrite or delete every other tenant's
   * anchor rows, with `verifyAnchors`'s application-level org filter as the only thing in the way.
   */
  it("a tenant cannot read, rewrite or delete another tenant's anchors", async () => {
    const headA = await asOrg(
      ORG_A,
      (tx) => tx`select id, hash from audit_log order by id desc limit 1`,
    );
    const headB = await asOrg(
      ORG_B,
      (tx) => tx`select id, hash from audit_log order by id desc limit 1`,
    );
    // Written on the maintenance path (unscoped here) — which is how anchoring actually runs.
    // Each anchor test tags its rows with its own `sink` so the two can coexist until `afterAll`
    // tears them down; `audit_anchors.id` is a `bigserial`, so there is no deterministic id to key
    // on the way every other fixture in this file does.
    await maint`insert into audit_anchors (org_id, max_audit_id, head_hash, sink)
                values (${ORG_A}, ${headA[0]!.id}, ${headA[0]!.hash}, 'test-policy'),
                       (${ORG_B}, ${headB[0]!.id}, ${headB[0]!.hash}, 'test-policy')`;

    // READ: org A sees its own anchors and none of org B's.
    const visible = await asOrg(ORG_A, (tx) => tx`select org_id from audit_anchors`);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every((r) => r.org_id === ORG_A)).toBe(true);

    // WRITE: refused outright rather than filtered. With RLS enabled and no policy for the command,
    // the command matches nothing — so a tenant cannot forge an anchor even for ITSELF, which is
    // the "cannot opt out of anchoring" property expressed as a permission.
    const updated = await asOrg(
      ORG_A,
      (tx) => tx`update audit_anchors set head_hash = 'hijacked' returning id`,
    );
    expect(updated).toHaveLength(0);
    const deleted = await asOrg(ORG_A, (tx) => tx`delete from audit_anchors returning id`);
    expect(deleted).toHaveLength(0);

    // Everything is still there, unmodified, for both tenants.
    const survivors =
      await maint`select org_id, head_hash from audit_anchors where sink = 'test-policy'`;
    expect(survivors).toHaveLength(2);
    expect(survivors.some((r) => r.head_hash === "hijacked")).toBe(false);
  });

  it("anchors from two orgs stay attributable to their own chains", async () => {
    const headA = await asOrg(
      ORG_A,
      (tx) => tx`select id, hash from audit_log order by id desc limit 1`,
    );
    const headB = await asOrg(
      ORG_B,
      (tx) => tx`select id, hash from audit_log order by id desc limit 1`,
    );
    expect(headA[0]).toBeDefined();
    expect(headB[0]).toBeDefined();
    // `audit_anchors` takes only READS from a tenant (migration 0014); writes belong to the
    // maintenance role, which is how anchoring actually runs — so these inserts and the
    // cross-tenant join below go over `maint`, not through `asOrg` and not through `unscoped`.
    await maint`insert into audit_anchors (org_id, max_audit_id, head_hash, sink)
                values (${ORG_A}, ${headA[0]!.id}, ${headA[0]!.hash}, 'test-attribution'),
                       (${ORG_B}, ${headB[0]!.id}, ${headB[0]!.hash}, 'test-attribution')`;
    const rows = await maint`select a.org_id, a.head_hash, l.org_id as chain_org
                             from audit_anchors a join audit_log l on l.id = a.max_audit_id
                             where a.sink = 'test-attribution'`;
    expect(rows).toHaveLength(2);
    // Each anchor pins a head that belongs to the SAME org it names. Before 0014 an anchor pinned
    // `max(audit_log.id)` across the deployment, so this join could legitimately cross tenants —
    // and a verification comparing that hash against the "wrong" chain would report a mismatch
    // that was not tampering.
    for (const row of rows) expect(row.chain_org).toBe(row.org_id);
  });
});
