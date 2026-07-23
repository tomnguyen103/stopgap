import { sql } from "drizzle-orm";
import {
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
    action: text("action").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    prevHash: text("prev_hash").notNull(),
    hash: text("hash").notNull(),
    /** Temporal workflow run this entry belongs to; part of the idempotency key. */
    runId: text("run_id"),
  },
  (t) => [
    index("audit_case_idx").on(t.caseId),
    index("audit_ts_idx").on(t.ts),
    // Within one workflow run each case action fires at most once, so (case_id, action,
    // run_id) is a natural idempotency key: a Temporal activity retry after a committed
    // insert lands here as a no-op instead of double-appending. run_id is in the key because
    // a recurring shortage opens a new run against the same case row (Phase 3).
    uniqueIndex("audit_case_action_uq").on(t.caseId, t.action, t.runId),
  ],
);

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

export type CaseRow = typeof cases.$inferSelect;
export type NewCaseRow = typeof cases.$inferInsert;
export type AuditRow = typeof auditLog.$inferSelect;
export type FeedRecordRow = typeof feedRecords.$inferSelect;
export type ProtocolRow = typeof protocols.$inferSelect;
export type ProtocolVersionRow = typeof protocolVersions.$inferSelect;
export type NewProtocolVersionRow = typeof protocolVersions.$inferInsert;
export type ShadowRunRow = typeof shadowRuns.$inferSelect;
export type NewShadowRunRow = typeof shadowRuns.$inferInsert;
