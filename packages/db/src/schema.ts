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
 */

/** One row per shortage case; mirrors the Temporal workflow's durable state to Postgres. */
export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Temporal workflow id (deterministic: `case-<key>`). Unique. */
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
    ndcs: jsonb("ndcs").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    lastNote: text("last_note"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("cases_workflow_id_uq").on(t.workflowId),
    index("cases_status_idx").on(t.status),
    index("cases_key_idx").on(t.key),
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
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    oidcSubject: text("oidc_subject"),
    email: text("email"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [
    // Partial unique index: two synthetic users legitimately have no subject, and Postgres
    // treats NULLs as distinct anyway — but a real `sub` must never map to two accounts.
    uniqueIndex("users_oidc_subject_uq").on(t.oidcSubject).where(sql`${t.oidcSubject} is not null`),
  ],
);

/**
 * Role grants (PHASE6 §6.1). Many-to-one against `users`; a user may hold several roles, so the
 * authorization check is "does any of my roles satisfy the required rank". `role` is a text
 * column carrying one of `@stopgap/core`'s `Role` literals rather than a PG enum — a new role
 * is then a code change, not a migration, and the app already validates the value on write.
 * `(userId, role)` is unique so re-granting an existing role is a no-op, not a duplicate row.
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
 */
export const escalationPolicies = pgTable(
  "escalation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    severity: text("severity").notNull(),
    steps: jsonb("steps").$type<{ afterMinutes: number; notify: string }[]>().notNull().default(sql`'[]'::jsonb`),
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
    uniqueIndex("acknowledgments_case_step_uq").on(t.caseId, t.step),
    index("acknowledgments_case_idx").on(t.caseId),
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
     */
    scheme: text("scheme").notNull().default("v1"),
  },
  (t) => [
    index("audit_case_idx").on(t.caseId),
    index("audit_ts_idx").on(t.ts),
    // Within one workflow run each case action fires at most once, so (case_id, action,
    // run_id) is a natural idempotency key: a Temporal activity retry after a committed
    // insert lands here as a no-op instead of double-appending. run_id is in the key because
    // a recurring shortage opens a new run against the same case row (Phase 3).
    uniqueIndex("audit_case_action_uq").on(t.caseId, t.eventKey, t.runId),
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
 */
export const auditAnchors = pgTable("audit_anchors", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** When this anchor was taken (the head it pins is the chain as of this moment). */
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  /** Highest `audit_log.id` covered by this anchor. */
  maxAuditId: bigint("max_audit_id", { mode: "number" }).notNull(),
  /** Hash of row `maxAuditId` at anchor time — the value re-verification compares against. */
  headHash: text("head_hash").notNull(),
  /** Where the anchor was written: `file` (always) or `tsa` (RFC 3161 token obtained). */
  sink: text("sink").notNull(),
  /** Reference into the sink — the anchor file path, or the base64 TSA token. Nullable. */
  sinkRef: text("sink_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Raw feed records for dedup + provenance; `(source, sourceId)` is unique. */
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
    /** Same normalized generic-name key the cases table uses, so a case finds its protocol. */
    key: text("key").notNull(),
    title: text("title").notNull(),
    /** Therapeutic class, when RxNorm resolved one — promotion gates are per drug class. */
    drugClass: text("drug_class"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("protocols_key_uq").on(t.key), index("protocols_class_idx").on(t.drugClass)],
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
    protocolId: uuid("protocol_id")
      .notNull()
      .references(() => protocols.id),
    /** Per-protocol version number (1, 2, 3...), assigned by the store, not a global sequence. */
    version: integer("version").notNull(),
    state: text("state").notNull().default("draft"),
    body: text("body").notNull(),
    /** Alternatives the protocol authorizes, in the order a pharmacist should consider them. */
    alternatives: jsonb("alternatives").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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
    uniqueIndex("protocol_versions_uq").on(t.protocolId, t.version),
    index("protocol_versions_state_idx").on(t.state),
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
    /** Replay-corpus entry id, so a run is traceable to the exact input it scored. */
    corpusId: text("corpus_id").notNull(),
    key: text("key").notNull(),
    drugClass: text("drug_class"),
    proposedSeverity: text("proposed_severity").notNull(),
    proposedAlternatives: jsonb("proposed_alternatives").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    baselineSeverity: text("baseline_severity").notNull(),
    baselineAlternatives: jsonb("baseline_alternatives").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
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
  (t) => [
    index("shadow_runs_key_idx").on(t.key),
    index("shadow_runs_class_idx").on(t.drugClass),
    index("shadow_runs_ran_at_idx").on(t.ranAt),
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
    key: text("key").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("demo_runs_started_at_idx").on(t.startedAt)],
);

export type EscalationPolicyRow = typeof escalationPolicies.$inferSelect;
export type EscalationStep = { afterMinutes: number; notify: string };
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
