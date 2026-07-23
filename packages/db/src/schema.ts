import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Phase 1 schema: durable case mirror, hash-chained audit log, and feed-record store for
 * dedup/provenance. Protocols, shadow ledger, and exception queue arrive in Phase 3.
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
  },
  (t) => [index("audit_case_idx").on(t.caseId), index("audit_ts_idx").on(t.ts)],
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

export type CaseRow = typeof cases.$inferSelect;
export type NewCaseRow = typeof cases.$inferInsert;
export type AuditRow = typeof auditLog.$inferSelect;
export type FeedRecordRow = typeof feedRecords.$inferSelect;
