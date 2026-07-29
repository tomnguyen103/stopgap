import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  numeric,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Phase 1 schema: durable case mirror, hash-chained audit log, and feed-record store for
 * dedup/provenance. Phase 3 adds the versioned protocol store (organizational memory) and
 * the shadow ledger.
 *
 * PHASE6 §6.5 splits every table into one of two classes, and the class is a deliberate
 * decision per table, never a default:
 *
 *  - TENANT tables carry a `orgId` FK, are covered by a `<table>_org_isolation` RLS policy
 *    (migration 0013), and are only ever read through an org-scoped connection (`withOrgDb`).
 *  - GLOBAL tables carry no `orgId`. Each one below states WHY in a comment beside it. The
 *    test is not "could this be per-org" but "would two orgs disagree about this row": a
 *    shared external fact, a deployment-wide budget, or a row already scoped transitively
 *    through a tenant table's FK is global.
 *
 * Every unique index on a tenant table was audited when `orgId` landed. Uniqueness that used
 * to mean "unique in the deployment" mostly has to become "unique WITHIN an org" (otherwise
 * the second hospital to hit a heparin shortage cannot open a case), but a few genuinely must
 * stay deployment-wide — those are called out individually, because silently widening them
 * would create a real vulnerability rather than a missing feature.
 */

/**
 * A tenant (PHASE6 §6.5) — one hospital or facility in a health system. The root of the
 * isolation model: every tenant table's `orgId` points here, and the RLS policies compare it
 * against the per-transaction `app.current_org` setting.
 *
 * `slug` is the stable human handle (URLs, ops commands, the compose seed); `name` is the
 * display string and is free to change without breaking a bookmark. Deliberately tiny: an org
 * is an isolation boundary, not a settings bag. Per-org configuration belongs on the table it
 * configures, so a new setting does not widen the row every RLS check reads.
 *
 * NOT itself an RLS-protected table: a session must be able to resolve its own org (and an
 * admin to list orgs) BEFORE `app.current_org` is set, which is exactly the chicken-and-egg an
 * isolation policy on this table would create. It holds no tenant data — only names.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("organizations_slug_uq").on(t.slug)],
);

/** One row per shortage case; mirrors the Temporal workflow's durable state to Postgres. */
export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5). RLS-enforced; see `organizations`. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /**
     * Temporal workflow id, unique WITHIN an org. Deterministic, and in one of TWO formats:
     * `workflowIdForKey` mints `org-<orgId>-case-<key>` since PHASE6 §6.5, while rows written
     * before that pass hold the older `case-<key>`. Temporal cannot rename a running execution, so
     * both formats stay live and every lookup uses the id the ROW carries rather than a recomputed
     * one.
     */
    workflowId: text("workflow_id").notNull(),
    /** Cross-feed dedup key: normalized generic name. */
    key: text("key").notNull(),
    genericName: text("generic_name").notNull(),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    status: text("status").notNull().default("detected"),
    severity: text("severity"),
    /**
     * Consecutive feed polls that no longer listed this shortage while the case was still
     * monitoring (PHASE6 §6.6). Reset to 0 the moment the key reappears as `current`; at
     * `FEED_RESOLVE_MISS_THRESHOLD` misses the poll signals the case resolved. A counter, not
     * a timestamp log: the poll only ever asks "how many misses in a row", and a single miss
     * (feed flap) must never resolve a live shortage.
     */
    feedMissCount: integer("feed_miss_count").notNull().default(0),
    /**
     * The feed-poll run that last touched `feedMissCount` (PHASE6 §6.6). `pollAndOpenCases` is
     * at-least-once, so a retry after a partial failure would otherwise re-increment cases it
     * already bumped and resolve them too early. `bumpFeedMiss` guards on this being DISTINCT
     * from the current run, making the per-poll counter update idempotent under retry.
     */
    lastFeedPollRun: text("last_feed_poll_run"),
    ndcs: jsonb("ndcs")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastNote: text("last_note"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    // WIDENED to (org_id, workflow_id) in migration 0013. `workflowIdForKey` is a pure function
    // of the dedup key, so two hospitals both short on heparin compute the SAME `case-heparin`
    // id; deployment-wide uniqueness would let the first org to detect it permanently block the
    // second from opening a case. Org-leading, so it doubles as the org-filter index — no extra
    // `cases_org_idx` is needed.
    uniqueIndex("cases_workflow_id_uq").on(t.orgId, t.workflowId),
    // Both lookups (queue by status, dedup by key) are now ALWAYS org-scoped, so the org column
    // leads: a bare `status` index would make every org walk every other org's rows before the
    // RLS predicate discarded them.
    index("cases_status_idx").on(t.orgId, t.status),
    // UNIQUE since migration 0014. `(org_id, key)` is the identity this codebase actually treats a
    // case by: `getCaseByKey` is the only sanctioned way to find one, `upsertCaseForRecord` decides
    // "does this org already have a case for this drug?" by reading it, and the console addresses
    // cases through it. All of that was resting on a NON-unique index plus the convention that the
    // upsert checks first — so two concurrent detections could interleave their check and insert
    // and leave one org holding two cases for one drug, after which `getCaseByKey`'s unqualified
    // `.limit(1)` would return whichever the planner happened to emit first and the console would
    // flip between them between page loads.
    //
    // Safe to promote against existing data: before 0013 `cases_workflow_id_uq` was unique on
    // `workflow_id` alone, and `workflow_id` was `case-<key>` — a pure function of the key — so a
    // duplicate `(org_id, key)` could not have been written. Migration 0014 creates it as a unique
    // index rather than adding an `ORDER BY` for that reason: the constraint states the invariant
    // the code already relies on instead of making a non-deterministic read merely deterministic.
    uniqueIndex("cases_key_uq").on(t.orgId, t.key),
  ],
);

/**
 * Authenticated principals (PHASE6 §6.1). One row per human who signed in through the OIDC
 * IdP, plus two synthetic rows — `system` and `agent` — that give the pre-auth actors of the
 * audit chain a stable `users.id` to point at. `oidcSubject` is the IdP's `sub` claim and is
 * UNIQUE where present; the synthetic users carry a sentinel subject (`system`/`agent`) rather
 * than NULL so the backfill and `getSyntheticUser` can find them deterministically. `email`
 * and `displayName` are best-effort from the token — nullable, because a synthetic user has no
 * inbox. `disabledAt` soft-disables an account without deleting its audit provenance.
 *
 * TENANT table (PHASE6 §6.5): a user belongs to exactly one org. See the note on
 * `users_oidc_subject_uq` below for why that is a deliberate constraint and not an oversight.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5). The synthetic `system`/`agent` users belong to the seed org. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    oidcSubject: text("oidc_subject"),
    email: text("email"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique index: two synthetic users legitimately have no subject, and Postgres
    // treats NULLs as distinct anyway — but a real `sub` must never map to two accounts.
    //
    // DELIBERATELY NOT WIDENED to (org_id, oidc_subject) in migration 0013, unlike every other
    // unique index on a tenant table. Widening would let one IdP subject exist in two orgs, and
    // the sign-in path cannot survive that: the OIDC callback carries a `sub` and nothing else —
    // there is no org selector at the IdP, so `getUserByOidc(sub)` would become ambiguous and
    // would have to guess which tenant the human just authenticated into. Guessing an isolation
    // boundary is the one failure mode this whole item exists to prevent, so the constraint stays
    // deployment-wide: one IdP subject = one user row = one org.
    //
    // The cost is real and accepted: a pharmacist covering two facilities needs two IdP subjects
    // today. The fix, if it is ever wanted, is a `user_organizations` join table plus an org
    // picker after sign-in — a feature with its own UI, not a silently relaxed index.
    uniqueIndex("users_oidc_subject_uq")
      .on(t.oidcSubject)
      .where(sql`${t.oidcSubject} is not null`),
    index("users_org_idx").on(t.orgId),
  ],
);

/**
 * Role grants (PHASE6 §6.1). Many-to-one against `users`; a user may hold several roles, so the
 * authorization check is "does any of my roles satisfy the required rank". `role` is a text
 * column carrying one of `@stopgap/core`'s `Role` literals rather than a PG enum — a new role
 * is then a code change, not a migration, and the app already validates the value on write.
 * `(userId, role)` is unique so re-granting an existing role is a no-op, not a duplicate row.
 *
 * GLOBAL table (PHASE6 §6.5) — no `orgId`, scoped TRANSITIVELY through `users`. A role grant is
 * meaningless without the user it names, and that user already carries the tenant; duplicating
 * `orgId` here would create a second copy of the same fact that could disagree with the first.
 */
export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("user_roles_user_role_uq").on(t.userId, t.role)],
);

/**
 * Escalation ladders (PHASE6 §6.3). One row per severity — a `unique` on `severity` enforces a
 * single ladder per severity, so "the critical ladder" is unambiguous. `steps` is an ordered
 * jsonb array `[{afterMinutes, notify}]`: `afterMinutes` is the delay from escalation start
 * before that tier is notified (0 = immediate), `notify` is the role or channel to page. Stored
 * as data (editable by an admin) rather than hard-coded so the on-call ladder is a config change,
 * not a deploy.
 *
 * GLOBAL table (PHASE6 §6.5) — no `orgId`, and this one is a genuine open question rather than a
 * settled fact: per-severity ladders are currently deployment-wide config, and a later PR may
 * well make them per-org (a teaching hospital's critical ladder is not a clinic's). Left global
 * here because doing it properly means widening `escalation_policies_severity_uq` to
 * (org_id, severity) AND giving every org a seeded ladder at creation time, which is escalation
 * work, not data-layer work. Until then every org shares one ladder — stated plainly so nobody
 * mistakes it for isolation that already exists.
 */
export type EscalationStep = { afterMinutes: number; notify: string };

export const escalationPolicies = pgTable(
  "escalation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    severity: text("severity").notNull(),
    steps: jsonb("steps")
      .$type<EscalationStep[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("escalation_policies_severity_uq").on(t.severity)],
);

/**
 * Human acknowledgments of an escalating case (PHASE6 §6.3) — the "did someone see it" record
 * ops systems live on. One row per acknowledged step: `unique(caseId, step)` so a retried signal
 * or a double-click cannot write two acks for the same tier, and `ackAt`/`userId` answer "who,
 * when" for the escalation timeline. `userId` is a real `users.id` (never a claimed string), so
 * the acknowledgment is attributable in the same way the audit chain's `actorUserId` is.
 */
export const acknowledgments = pgTable(
  "acknowledgments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5) — redundant with `caseId`'s org, and deliberately so: RLS
     * predicates read a column on the row being checked, not one two joins away. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    step: integer("step").notNull(),
    ackAt: timestamp("ack_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // NOT widened with `org_id`: `caseId` is a globally unique uuid that already carries exactly
    // one org, so (org_id, case_id, step) would be strictly WEAKER — it would permit two acks for
    // the same case and step under two different org labels, which is the double-ack this index
    // exists to stop.
    uniqueIndex("acknowledgments_case_step_uq").on(t.caseId, t.step),
    index("acknowledgments_case_idx").on(t.caseId),
    index("acknowledgments_org_idx").on(t.orgId),
  ],
);

/**
 * Append-only, hash-chained audit log (triage-md pattern). Each row's `hash` = SHA-256 of
 * (prevHash + canonical(row-without-hash)); tampering with any row breaks the chain.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /**
     * Owning tenant (PHASE6 §6.5). The chain is PER-ORG: `appendAudit` reads the previous hash
     * within this org, and scheme `v4` folds this column into the HMAC so a row cannot be moved
     * between tenants without breaking its hash. NOT NULL even for console-level entries with no
     * `caseId` — an audit row with no tenant would be invisible to every org, which is a silent
     * hole in exactly the table whose job is to have no holes.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    caseId: uuid("case_id").references(() => cases.id),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    actor: text("actor").notNull(),
    /**
     * The authenticated principal behind this entry (PHASE6 §6.1) — a real `users.id`, never a
     * client-supplied string. Deliberately NOT part of the hashed payload: `actor` (text) stays
     * the hashed identity field so the HMAC/SHA-256 chain verifies BYTE-FOR-BYTE across this
     * migration (existing rows are untouched by adding a column the hash ignores). This FK is
     * the machine-checkable "who", `actor` the stable human label the chain commits to.
     * Nullable: legacy rows whose text actor was neither `system` nor `agent`, and synthetic
     * system/agent activity, keep a NULL here with the text label intact.
     */
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    /**
     * Temporal workflow run this entry belongs to; part of the idempotency key. Empty string
     * (not NULL) outside a workflow run: Postgres treats NULLs as distinct in a unique index,
     * so a nullable column here would silently switch the idempotency backstop off for
     * exactly the rows that need it.
     */
    runId: text("run_id").notNull().default(""),
    /**
     * The logical event within a run, for idempotency. Defaults to `action`; legs that
     * legitimately repeat set something finer (the weekly monitoring tick keys on its week
     * number, or every tick after the first would be discarded as a retry).
     */
    eventKey: text("event_key").notNull().default(""),
    /**
     * Hashing scheme for this row (PHASE6 §6.2). `v1` = bare SHA-256 (the original,
     * tamper-evident but recomputable by anyone with DB write access); `v2` = HMAC-SHA-256
     * under `AUDIT_HMAC_KEY`, whose key lives outside the DB so a write-only attacker can no
     * longer forge a valid chain. Stored per row, not global, so a deployment that turns the
     * key on keeps verifying its existing `v1` rows instead of invalidating history.
     *
     * `v4` (PHASE6 §6.5) = the `v3` field set PLUS `orgId`, so a keyed row cannot be relabelled
     * into another tenant without breaking its hash.
     */
    scheme: text("scheme").notNull().default("v1"),
  },
  (t) => [
    index("audit_case_idx").on(t.caseId),
    // Org-leading: chain verification and the console timeline both read "this org's rows in id
    // order", never the deployment's. A bare `ts` index would scan every tenant's history.
    index("audit_ts_idx").on(t.orgId, t.ts),
    // ON THE ADVISORY LOCK'S CRITICAL PATH (migration 0014). `appendAudit` holds
    // `pg_advisory_xact_lock('audit_log_chain:' || org_id)` while it reads this org's chain tail —
    // `where org_id = ? order by id desc limit 1` — so every other append for that tenant waits on
    // that read. Nothing else here serves it: `audit_ts_idx` orders by `ts`, not `id`, and
    // `audit_case_action_uq`'s second column is `case_id`. Without this the tail read scans or
    // sorts the org's whole history inside the lock, making append latency a function of chain
    // length on the one table that only ever grows.
    index("audit_org_id_idx").on(t.orgId, t.id),
    // Within one workflow run each case action fires at most once, so (case_id, action,
    // run_id) is a natural idempotency key: a Temporal activity retry after a committed
    // insert lands here as a no-op instead of double-appending. run_id is in the key because
    // a recurring shortage opens a new run against the same case row (Phase 3).
    //
    // WIDENED with `org_id` in migration 0013. It does not tighten the key (a `caseId` already
    // belongs to one org, and a cross-org insert is refused by the policy's WITH CHECK); it is
    // here so the index LEADS with the column every query now filters on, which is also what
    // makes a separate `audit_log_org_idx` unnecessary.
    uniqueIndex("audit_case_action_uq").on(t.orgId, t.caseId, t.eventKey, t.runId),
  ],
);

/**
 * External anchors of the audit chain (PHASE6 §6.2). Every hour a Temporal schedule records
 * the current chain head — `(maxAuditId, headHash)` — to an append-only sink outside the
 * database (a file on a Docker volume, optionally an RFC 3161 timestamp token). HMAC stops a
 * write-only attacker forging rows; the anchor stops even a key holder from rewriting history
 * unnoticed, because the original head hash lives somewhere they cannot silently edit. This
 * table mirrors what was anchored so the verification UI can cross-check stored heads against
 * the live chain.
 *
 * PER-ORG SINCE MIGRATION 0014 (PHASE6 §6.5 pass 2), and this is a correction, not an extension.
 * Pass 1 made the audit CHAIN per-org — each tenant runs its own hash chain from its own genesis —
 * but left this table global, which quietly made every row here ambiguous: "the head hash" is no
 * longer one value, and an anchor pinning `max(audit_log.id)` pins whichever tenant happened to
 * append last. `verifyAnchors` would then compare that hash against a chain it may not belong to
 * and report a mismatch that is not tampering, or (worse) a match that proves nothing about the
 * org whose history someone actually rewrote. One anchor row per org per run makes the pinned head
 * mean exactly one thing again.
 *
 * 0014 also gives it RLS, with a deliberately ASYMMETRIC policy — SELECT only, no write policy at
 * all. See the index/policy block at the bottom of this table for what that buys and why.
 */
export const auditAnchors = pgTable(
  "audit_anchors",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /**
     * The tenant whose chain head this anchor pins (PHASE6 §6.5, migration 0014). NOT NULL:
     * migration 0014 backfills every pre-existing anchor to the seed org, which is the tenant whose
     * chain those anchors were in fact taken over — before 0013 there was only one.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** When this anchor was taken (the head it pins is the chain as of this moment). */
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /** Highest `audit_log.id` covered by this anchor, WITHIN `orgId`'s chain. */
    maxAuditId: bigint("max_audit_id", { mode: "number" }).notNull(),
    /** Hash of row `maxAuditId` at anchor time — the value re-verification compares against. */
    headHash: text("head_hash").notNull(),
    /** Where the anchor was written: `file` (always) or `tsa` (RFC 3161 token obtained). */
    sink: text("sink").notNull(),
    /** Reference into the sink — the anchor file path, or the base64 TSA token. Nullable. */
    sinkRef: text("sink_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Verification reads anchors newest-first per org; the org leads so one tenant's history check
    // does not walk every other tenant's anchors first.
    index("audit_anchors_org_idx").on(t.orgId, t.id),
    // RLS: SELECT-only, since migration 0014. This table is a hybrid and the asymmetry is the design.
    // READS are scoped like any tenant table — an org may see the anchors that pin its own chain and
    // nothing else, because anchor metadata (when a tenant last appended, how much history it has) is
    // still that tenant's information. WRITES are left entirely to the maintenance (BYPASSRLS) role:
    // there is no INSERT/UPDATE/DELETE policy, so an org-scoped connection cannot touch a row at all.
    //
    // That is what keeps BOTH properties. A tenant cannot opt out of being anchored (it cannot delete
    // or rewrite its anchors, and cannot stop the maintenance role writing new ones), and it also
    // cannot reach another tenant's anchors — which, before this, it could: with no policy at all, an
    // ordinary org-scoped connection could UPDATE or DELETE every other hospital's anchor rows, and
    // `verifyAnchors`'s explicit org filter was the only thing standing between a tenant and every
    // other tenant's integrity metadata.
  ],
);

/**
 * Raw feed records for dedup + provenance; `(source, sourceId)` is unique.
 *
 * GLOBAL table (PHASE6 §6.5) — no `orgId`. This is EXTERNAL data, not tenant data: one openFDA
 * shortage record is one physical fact about the drug supply, identical for every hospital that
 * reads it. Per-org copies would multiply the poller's writes by the tenant count to store N
 * byte-identical rows, and `(source, source_id)` — the dedup contract the whole ingest path rests
 * on — would stop meaning "we have already seen this record".
 */
export const feedRecords = pgTable(
  "feed_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    sourceId: text("source_id").notNull(),
    key: text("key").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    /** SHA-256 of the normalized payload; lets us skip unchanged records. */
    contentHash: text("content_hash").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("feed_records_source_uq").on(t.source, t.sourceId)],
);

/**
 * Versioned protocol store — the organizational memory (PROJECT_PLAN §3B). One row per
 * substitution protocol, keyed by the shortage key it covers; the current text lives in
 * `protocolVersions`, so history is never overwritten.
 */
export const protocols = pgTable(
  "protocols",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5). Substitution guidance is the most org-specific data here —
     * two hospitals with different formularies must be able to hold different protocols for the
     * same drug, which is exactly what the widened `protocols_key_uq` below permits. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Same normalized generic-name key the cases table uses, so a case finds its protocol. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    /** Therapeutic class, when RxNorm resolved one — promotion gates are per drug class. */
    drugClass: text("drug_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // WIDENED to (org_id, key) in migration 0013 — the single most consequential widening in this
    // migration. Left deployment-wide, the first org to write a heparin protocol would own the
    // key forever and every other hospital's `draftProtocolVersion` would fail on the unique
    // index. Org-leading, so it also serves as the org-filter index.
    uniqueIndex("protocols_key_uq").on(t.orgId, t.key),
    index("protocols_class_idx").on(t.orgId, t.drugClass),
  ],
);

/**
 * An immutable version of a protocol. `state` moves draft -> approved -> superseded; the
 * approved version with the highest `version` is what a new case reuses. Provenance is
 * mandatory: `sourceCaseId` records which case produced this text and `approvedBy` who
 * shipped it, so "why does this rule exist" is answerable from the row itself.
 */
export const protocolVersions = pgTable(
  "protocol_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5) — denormalized from the parent protocol so the RLS predicate
     * can read it off this row instead of joining. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocols.id),
    /** Per-protocol version number (1, 2, 3...), assigned by the store, not a global sequence. */
    version: integer("version").notNull(),
    state: text("state").notNull().default("draft"),
    body: text("body").notNull(),
    /** Alternatives the protocol authorizes, in the order a pharmacist should consider them. */
    alternatives: jsonb("alternatives")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The case whose resolution produced this version — the provenance link. */
    sourceCaseId: uuid("source_case_id").references(() => cases.id),
    /** "agent" for an agent-drafted version, a pharmacist id once a human edits/approves. */
    authoredBy: text("authored_by").notNull(),
    approvedBy: text("approved_by"),
    /**
     * Authenticated author/approver (PHASE6 §6.1) — real `users.id`s beside the free-text
     * `authoredBy`/`approvedBy`. Same rationale as `auditLog.actorUserId`: the text columns are
     * kept exactly as-is (they are what the provenance-audit entries hash), and these FKs add
     * the machine-checkable identity without rewriting history. `authoredByUserId` backfills to
     * the synthetic `agent` user for legacy agent drafts; both are nullable for human ids that
     * predate the users table.
     */
    authoredByUserId: uuid("authored_by_user_id").references(() => users.id),
    approvedByUserId: uuid("approved_by_user_id").references(() => users.id),
    /** Why this version exists (exception resolution rationale, edit reason). */
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
  },
  (t) => [
    // AUDITED AND DELIBERATELY NOT WIDENED. `protocolId` is a globally unique uuid belonging to
    // exactly one org, so "version 3 of protocol X" is already unambiguous across tenants; adding
    // `org_id` in front would strictly WEAKEN the constraint, letting the same protocol hold two
    // version-3 rows under two org labels and quietly breaking the "history is never overwritten"
    // guarantee `draftProtocolVersion` depends on. Widening a unique index is not automatically
    // the multi-tenant move — it is only correct where the tuple was previously tenant-blind.
    uniqueIndex("protocol_versions_uq").on(t.protocolId, t.version),
    index("protocol_versions_state_idx").on(t.state),
    // A plain org index here rather than an org-leading composite: unlike `cases`/`protocols`,
    // this table has no org-leading unique index to piggyback on.
    index("protocol_versions_org_idx").on(t.orgId),
  ],
);

/**
 * Shadow ledger (PROJECT_PLAN §3A): one row per shadow run — what the agent proposed, what
 * the human baseline was, and whether they agreed. Promotion gates read aggregates of this
 * table; nothing here ever affects a live case.
 */
export const shadowRuns = pgTable(
  "shadow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5). Promotion gates read aggregates of this table, and an org
     * must be promoted on ITS OWN agreement record — never on another hospital's. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** Replay-corpus entry id, so a run is traceable to the exact input it scored. */
    corpusId: text("corpus_id").notNull(),
    key: text("key").notNull(),
    drugClass: text("drug_class"),
    proposedSeverity: text("proposed_severity").notNull(),
    proposedAlternatives: jsonb("proposed_alternatives")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    baselineSeverity: text("baseline_severity").notNull(),
    baselineAlternatives: jsonb("baseline_alternatives")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** 0-1 agreement against the human baseline (see @stopgap/shadow scoring). */
    agreement: numeric("agreement", { precision: 4, scale: 3 }).notNull(),
    severityAgreed: boolean("severity_agreed").notNull(),
    /**
     * True when the agent called the shortage LESS severe than the human baseline. Tracked
     * separately from plain disagreement because the two directions are not equally bad:
     * over-escalation wastes pharmacist time, under-escalation is the one that hurts patients
     * (PROJECT_PLAN §8 targets it at ~0), and the promotion gates bound it on its own.
     */
    severityUnderCalled: boolean("severity_under_called").notNull().default(false),
    latencyMs: integer("latency_ms").notNull(),
    usdCost: numeric("usd_cost", { precision: 12, scale: 8 }).notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // All three reads (by key, by class, newest-first) are now org-scoped, so each index leads with
  // `org_id` rather than adding a fourth single-column one.
  (t) => [
    index("shadow_runs_key_idx").on(t.orgId, t.key),
    index("shadow_runs_class_idx").on(t.orgId, t.drugClass),
    index("shadow_runs_ran_at_idx").on(t.orgId, t.ranAt),
  ],
);

/**
 * Daily LLM spend, one row per UTC calendar day (PROJECT_PLAN §11: the public demo needs a
 * hard daily budget cap). Aggregated rather than per-call because the cap only ever asks one
 * question — "how much has today cost?" — and a per-call table would grow without bound for
 * an answer that is a single number. Per-call truth stays in the OTel spans.
 *
 * `day` is a text `YYYY-MM-DD` in UTC, not a `date` column: the cap must mean the same thing
 * regardless of the database's timezone setting.
 *
 * GLOBAL table (PHASE6 §6.5) — no `orgId`. The cap it enforces is DEPLOYMENT-wide: it protects
 * one bill, paid by whoever runs the containers, against one provider account. Splitting it per
 * org would turn a hard ceiling into N independent ceilings summing to N times the budget, which
 * is precisely the runaway spend the cap exists to prevent.
 */
export const llmSpend = pgTable("llm_spend", {
  day: text("day").primaryKey(),
  usdCost: numeric("usd_cost", { precision: 12, scale: 8 }).notNull().default("0"),
  calls: integer("calls").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per accepted demo scenario start (PROJECT_PLAN §11 rate limiting).
 *
 * A separate table rather than counting `cases`: a demo drug reuses one case row, so
 * `cases.opened_at` stops moving after the first run and a count over it would let the limit
 * decay to "unlimited" within an hour. Rows are written when a run is accepted, so the count
 * is of attempts that were allowed through, not of cases that happened to be created.
 */
export const demoRuns = pgTable(
  "demo_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Owning tenant (PHASE6 §6.5). The public demo maps to the seed org, so the rate limit stays
     * a limit on the demo rather than a limit shared with a real hospital's traffic. */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    key: text("key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Org-leading: the only read is "how many runs for THIS org since THIS instant".
  (t) => [index("demo_runs_started_at_idx").on(t.orgId, t.startedAt)],
);

/**
 * Programmatic-access credentials (PHASE6 §6.7). One row per issued API key. The DB stores the
 * SHA-256 `keyHash` and NEVER the plaintext: the plaintext is shown to the issuing admin exactly
 * once, so a database read (backup, replica, dump, compromised analyst account) cannot mint a
 * usable credential. `keyPrefix` is the leading few plaintext characters, kept solely so a human
 * can tell two keys apart in the admin list — it is not enough material to authenticate with.
 *
 * `scopes` is a jsonb array of the `API_SCOPES` literals rather than a PG enum or a join table:
 * a new scope is then a code change, not a migration, and the issuing path already validates
 * every value on write. `rateLimitPerHour` lives per key so one noisy integration cannot starve
 * the others. `createdByUserId` is the human who issued the key — the attribution the audit chain
 * records for anything the key later does — and is nullable because a key issued before an IdP
 * was wired has no human `users.id` to point at. `revokedAt` soft-revokes: deleting the row would
 * destroy the provenance of every audit entry that names the key.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /**
     * The tenant this key acts as (PHASE6 §6.5). A presented key is how an unauthenticated HTTP
     * request acquires an org at all: the REST layer resolves the key, reads this column, and
     * opens the request's `withOrgDb` scope from it. That is why `api_keys_key_hash_uq` below
     * must stay deployment-wide — the lookup happens BEFORE any org is known.
     */
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    /** SHA-256 hex of the plaintext key. Unique: two keys must never collide onto one identity. */
    keyHash: text("key_hash").notNull(),
    /**
     * The `sk_live_` namespace plus the first few characters of the key's RANDOM segment — enough
     * to tell two issued keys apart in the admin table, useless for authentication. The random
     * characters are the point: the namespace alone is identical on every row.
     */
    keyPrefix: text("key_prefix").notNull(),
    scopes: jsonb("scopes")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rateLimitPerHour: integer("rate_limit_per_hour").notNull().default(1000),
    createdByUserId: uuid("created_by_user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // AUDITED AND DELIBERATELY NOT WIDENED — widening this one would be a real vulnerability, not
    // a missing feature. `findActiveApiKeyByPlaintext` hashes the presented secret and looks it up
    // with NO org in hand (the org is the ANSWER, not an input), so a (org_id, key_hash) index
    // could not serve the lookup; worse, it would permit the identical secret to authenticate as
    // two different tenants. One secret must map to exactly one identity, deployment-wide.
    uniqueIndex("api_keys_key_hash_uq").on(t.keyHash),
    index("api_keys_org_idx").on(t.orgId),
  ],
);

/**
 * One row per API request a key was ALLOWED to make — the sliding-window counter behind the
 * per-key rate limit (PHASE6 §6.7), mirroring `demo_runs`.
 *
 * A table rather than a process-local counter for the same two reasons the demo limiter uses one:
 * the limit must survive a console restart (an in-memory map resets to zero and hands an attacker
 * a fresh budget by crashing the process), and it must hold ACROSS REPLICAS (two console
 * containers behind a load balancer would otherwise each grant the full hourly quota). Rows are
 * written when a request is admitted, so the count is of attempts allowed through, not of requests
 * that happened to succeed — a limit bounds attempts, not successes.
 *
 * GLOBAL table (PHASE6 §6.5) — no `orgId`, scoped TRANSITIVELY through `api_keys`. Every read is
 * "how many rows for THIS key", and a key belongs to exactly one org, so the tenant is already
 * pinned by the FK. Also: this row is written on the authentication path, BEFORE the request has
 * an org-scoped connection, so an RLS policy here would have to be satisfied by a session that
 * does not yet know its org.
 */
export const apiKeyRequests = pgTable(
  "api_key_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Composite (key, at): every read is "how many rows for THIS key since THIS instant", so a
  // per-key index over the timestamp answers the window count without scanning other keys' rows.
  (t) => [index("api_key_requests_key_at_idx").on(t.apiKeyId, t.at)],
);

/**
 * ---------------------------------------------------------------------------------------------
 * Normalized signals and the scores derived from them (ticket 06). Both TENANT tables.
 * ---------------------------------------------------------------------------------------------
 *
 * The asymmetry with `feed_records` above is deliberate and is the whole reason this table exists
 * separately. A FEED RECORD is one physical fact about the drug supply — openFDA's snapshot of a
 * heparin shortage is byte-identical for every hospital in the deployment, so it is stored once,
 * globally, and the HTTP fetch happens once.
 *
 * A RISK SIGNAL is that fact INTERPRETED for one facility: matched against what this hospital
 * stocks, weighted by how exposed it is, carrying its own dedupe key and its own resolution state.
 * Two hospitals reading the same recall genuinely hold different signals. Storing signals globally
 * would either force one interpretation on every tenant or require a tenant column on a table with
 * no policy — which is a leak with extra steps.
 *
 * Same test, applied honestly: "would two orgs disagree about this row". For a feed record, never.
 * For a signal, always.
 */
export const riskSignals = pgTable(
  "risk_signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    /** `@stopgap/ingest`'s `SignalSource` — which feed said this. */
    source: text("source").notNull(),
    /** The feed's own identifier for the record, as given. */
    sourceId: text("source_id").notNull(),
    riskDomain: text("risk_domain").notNull(),
    entityType: text("entity_type").notNull(),
    entityIdentifier: text("entity_identifier").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    severity: text("severity").notNull(),
    /** The scorer's input. Carried BESIDE the label, never re-derived from it. */
    severityScore: numeric("severity_score", { precision: 5, scale: 4 }).notNull(),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }).notNull(),
    staleness: text("staleness").notNull(),
    /**
     * THE SOURCE says the hazard is over — a terminated recall, a resolved shortage.
     *
     * Stored as its own column, and NOT collapsed with `feedMissCount` below, because the two are
     * different facts with different consequences: this one is a WEIGHTING input the scorer decays,
     * that one is a STATUS TRANSITION the poller reconciles. A single "inactive" flag would make a
     * terminated recall and a record that merely fell out of the feed indistinguishable, and they
     * are not — a recall terminated last week still bears on what is safe to substitute into today.
     */
    sourceResolved: boolean("source_resolved").notNull().default(false),
    /**
     * Consecutive polls in which the feed no longer listed this signal.
     *
     * The same counter shape `cases.feedMissCount` already uses, and for the same reason: one miss
     * is feed flap, not a resolution, and the poll is at-least-once so the increment has to be
     * idempotent per run.
     */
    feedMissCount: integer("feed_miss_count").notNull().default(0),
    /** The poll run that last touched `feedMissCount`, making the increment retry-safe. */
    lastFeedPollRun: text("last_feed_poll_run"),
    evidenceUrl: text("evidence_url").notNull(),
    /** The provider payload, retained as evidence. Never re-parsed for meaning. */
    raw: jsonb("raw").notNull(),
    /** `<org>:<source>:<sourceId>` — the contract's key, as `signalDedupeKey` spells it. */
    dedupeKey: text("dedupe_key").notNull(),
    /** NDCs, RxCUIs and names, for the catalog association ticket 16 performs. */
    matchHints: jsonb("match_hints")
      .$type<{ ndcs: string[]; rxcuis: string[]; names: string[] }>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The dedupe key already embeds the org, but the index leads with `org_id` anyway: it is what
    // makes this double as the org-filter index, and it keeps uniqueness meaning "within this
    // tenant" even if the key's shape is ever changed.
    uniqueIndex("risk_signals_dedupe_uq").on(t.orgId, t.dedupeKey),
    index("risk_signals_domain_idx").on(t.orgId, t.riskDomain, t.publishedAt),
    index("risk_signals_entity_idx").on(t.orgId, t.entityIdentifier),
  ],
);

/**
 * A score computed from a signal, at a moment, by a named scorer version (ticket 07 computes them).
 *
 * A SNAPSHOT rather than a column on the signal: a score is the output of a weighting that changes
 * as the scorer is tuned, and overwriting yesterday's number would destroy the only evidence of
 * what the console showed a pharmacist when they made a decision. The audit trail is the point —
 * "why was this ranked first on Tuesday" has to stay answerable after the weights move.
 */
export const riskScoreSnapshots = pgTable(
  "risk_score_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => riskSignals.id, { onDelete: "cascade" }),
    /** 0–100, as the console ranks on. */
    score: numeric("score", { precision: 6, scale: 2 }).notNull(),
    /** The banded reading of the same number, for filtering. */
    band: text("band").notNull(),
    /**
     * The per-component breakdown behind the number.
     *
     * Stored because a score a pharmacist cannot decompose is a score they cannot argue with, and
     * ADR-0002 is explicit that the number is arithmetic rather than a model's opinion — which is
     * only meaningful if the arithmetic is visible.
     */
    components: jsonb("components")
      .$type<
        Record<
          string,
          { points: number; max: number; available: boolean; unavailableReason?: string }
        >
      >()
      .notNull(),
    /**
     * The points this score COULD have earned, given what was known when it was computed.
     *
     * Stored rather than recomputed, because it moves: 65 while the catalog components are dormant,
     * 100 once inventory and supplier data land. A reader comparing two snapshots taken either side
     * of that change needs to know which denominator each was scored against — without it, a score
     * that rose because more became knowable is indistinguishable from one that rose because the
     * hazard got worse.
     */
    reachableMax: numeric("reachable_max", { precision: 6, scale: 2 }).notNull(),
    /** Which scorer produced it. A score without its version is not reproducible. */
    scorerVersion: text("scorer_version").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One snapshot per (signal, scorer version, moment): re-running the same scorer over the same
    // signal in the same poll restates one row instead of appending a duplicate history entry.
    uniqueIndex("risk_score_snapshots_point_uq").on(
      t.orgId,
      t.signalId,
      t.scorerVersion,
      t.computedAt,
    ),
    index("risk_score_snapshots_rank_idx").on(t.orgId, t.computedAt, t.score),
    // `latestScoresForSignals` reads by signal; without this it walks the tenant's whole history.
    index("risk_score_snapshots_signal_idx").on(t.orgId, t.signalId, t.computedAt),
  ],
);

export type OrganizationRow = typeof organizations.$inferSelect;
export type RiskSignalRow = typeof riskSignals.$inferSelect;
export type NewRiskSignalRow = typeof riskSignals.$inferInsert;
export type RiskScoreSnapshotRow = typeof riskScoreSnapshots.$inferSelect;
export type NewRiskScoreSnapshotRow = typeof riskScoreSnapshots.$inferInsert;
export type NewOrganizationRow = typeof organizations.$inferInsert;
export type EscalationPolicyRow = typeof escalationPolicies.$inferSelect;
export type AcknowledgmentRow = typeof acknowledgments.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type UserRoleRow = typeof userRoles.$inferSelect;
export type CaseRow = typeof cases.$inferSelect;
export type NewCaseRow = typeof cases.$inferInsert;
export type AuditRow = typeof auditLog.$inferSelect;
export type AuditAnchorRow = typeof auditAnchors.$inferSelect;
export type FeedRecordRow = typeof feedRecords.$inferSelect;
export type ProtocolRow = typeof protocols.$inferSelect;
export type ProtocolVersionRow = typeof protocolVersions.$inferSelect;
export type NewProtocolVersionRow = typeof protocolVersions.$inferInsert;
export type ShadowRunRow = typeof shadowRuns.$inferSelect;
export type NewShadowRunRow = typeof shadowRuns.$inferInsert;
export type LlmSpendRow = typeof llmSpend.$inferSelect;
export type DemoRunRow = typeof demoRuns.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type NewApiKeyRow = typeof apiKeys.$inferInsert;
export type ApiKeyRequestRow = typeof apiKeyRequests.$inferSelect;

/**
 * ---------------------------------------------------------------------------------------------
 * The facility catalog (ticket 15). Eight TENANT tables — what this hospital actually stocks.
 * ---------------------------------------------------------------------------------------------
 *
 * Every table here carries `orgId` and an `<table>_org_isolation` policy (migration 0015). None of
 * it is a shared external fact: two hospitals stocking the same drug hold genuinely different
 * items, different suppliers, different contract prices and different shelves. Applying the
 * Â§6.5 test — "would two orgs disagree about this row" — every one of them is tenant data, and
 * the answer is not close.
 *
 * Every unique index is org-leading, so it doubles as the org-filter index and so that uniqueness
 * means "unique WITHIN this hospital". A deployment-wide unique on `sku` or `supplier_code` would
 * let the first tenant to upload a catalog claim those codes forever.
 */

/** One stocked product, as this facility records it. `sku` is the facility's own code for it. */
export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    /** Normalized generic name where the file gave one — the join to shortage signals. */
    genericName: text("generic_name"),
    unit: text("unit"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("items_sku_uq").on(t.orgId, t.sku),
    index("items_generic_idx").on(t.orgId, t.genericName),
  ],
);

/**
 * The several identifiers one item carries at once.
 *
 * A separate table rather than columns on `items`, because facilities record products differently
 * across systems and the set is open — a purchasing system knows a GTIN, a pharmacy system an NDC,
 * an EHR an RxCUI, and the same physical product carries all three. Columns would force a schema
 * change for each new system; rows do not.
 */
export const itemIdentifiers = pgTable(
  "item_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** `ndc` | `rxcui` | `gtin` | `hibc` | `sku` — the vocabulary in `@stopgap/catalog`. */
    type: text("type").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    // One (type, value) pair points at ONE item within a tenant. This is the key a corrected
    // re-upload matches on, which is why it is unique rather than merely indexed.
    uniqueIndex("item_identifiers_value_uq").on(t.orgId, t.type, t.value),
    index("item_identifiers_item_idx").on(t.orgId, t.itemId),
  ],
);

/** A vendor this facility buys from. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("suppliers_code_uq").on(t.orgId, t.code)],
);

/** A vendor's individual site. Sole-source exposure is about SITES, not about companies. */
export const supplierSites = pgTable(
  "supplier_sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name"),
    country: text("country"),
    leadTimeDays: integer("lead_time_days"),
  },
  (t) => [uniqueIndex("supplier_sites_code_uq").on(t.orgId, t.supplierId, t.code)],
);

/** Which suppliers can supply which item, and on what terms. */
export const itemSuppliers = pgTable(
  "item_suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    /** The specific site, when the file named one. */
    siteId: uuid("site_id").references(() => supplierSites.id, { onDelete: "set null" }),
    contractPrice: numeric("contract_price", { precision: 14, scale: 4 }),
    preferred: boolean("preferred").notNull().default(false),
  },
  (t) => [
    // One link per (item, supplier) pair — the site is an attribute of the link, not part of its
    // identity. Including a NULLABLE site in the key would let the same pair appear twice, once
    // with a site and once without, because NULL is never equal to itself in a unique index.
    uniqueIndex("item_suppliers_pair_uq").on(t.orgId, t.itemId, t.supplierId),
    index("item_suppliers_supplier_idx").on(t.orgId, t.supplierId),
  ],
);

/** A place that holds stock — a hospital site, a ward store, a central pharmacy. */
export const facilities = pgTable(
  "facilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    code: text("code").notNull(),
    name: text("name"),
  },
  (t) => [uniqueIndex("facilities_code_uq").on(t.orgId, t.code)],
);

/**
 * On-hand stock at a point in time.
 *
 * A SNAPSHOT rather than a mutable level: "how much do we hold" is a question with a date on it,
 * and overwriting yesterday's count would destroy the only evidence of how fast a drug is moving —
 * which is the input a burn-rate reading needs.
 */
export const inventorySnapshots = pgTable(
  "inventory_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    onHand: numeric("on_hand", { precision: 14, scale: 3 }).notNull(),
    unit: text("unit"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    // Re-uploading a corrected file must UPDATE the count for that facility, item and moment
    // rather than add a second one — the natural key of a snapshot is when it was taken.
    uniqueIndex("inventory_snapshots_point_uq").on(t.orgId, t.facilityId, t.itemId, t.capturedAt),
    index("inventory_snapshots_item_idx").on(t.orgId, t.itemId, t.capturedAt),
  ],
);

/** What was ordered, from whom, and when. */
export const procurementEvents = pgTable(
  "procurement_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilities.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
    /**
     * The purchase-order reference, `''` when the file carried none.
     *
     * Part of the natural key, and NOT NULL with an empty-string default rather than nullable,
     * because NULL is not equal to itself in a unique index — a nullable column here would let the
     * same order be imported twice and would defeat the whole point of the key.
     */
    orderRef: text("order_ref").notNull().default(""),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull(),
    unitCost: numeric("unit_cost", { precision: 14, scale: 4 }),
  },
  (t) => [
    // An event's identity is NOT just its timestamp. Two genuine orders of the same item at the
    // same facility on the same date are ordinary — and common once a file gives dates rather than
    // datetimes — so the purchase-order reference is part of the key. Where a file carries no
    // reference the two orders are indistinguishable in the data, and the import restates one row
    // rather than inventing a difference the file does not contain.
    uniqueIndex("procurement_events_point_uq").on(
      t.orgId,
      t.facilityId,
      t.itemId,
      t.orderedAt,
      t.orderRef,
    ),
    index("procurement_events_item_idx").on(t.orgId, t.itemId, t.orderedAt),
  ],
);

export type CatalogItemRow = typeof items.$inferSelect;
export type NewCatalogItemRow = typeof items.$inferInsert;
export type ItemIdentifierRow = typeof itemIdentifiers.$inferSelect;
export type SupplierRow = typeof suppliers.$inferSelect;
export type SupplierSiteRow = typeof supplierSites.$inferSelect;
export type ItemSupplierRow = typeof itemSuppliers.$inferSelect;
export type FacilityRow = typeof facilities.$inferSelect;
export type InventorySnapshotRow = typeof inventorySnapshots.$inferSelect;
export type ProcurementEventRow = typeof procurementEvents.$inferSelect;
