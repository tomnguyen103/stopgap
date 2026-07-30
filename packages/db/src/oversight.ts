import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { acknowledgments, alertEvents, alertRules, cases } from "./schema.js";
import type { AlertEventRow } from "./schema.js";
import type { Db } from "./client.js";

/**
 * What a pharmacy director's oversight surface reads (ticket 14).
 *
 * Every query here carries an explicit org predicate as well as relying on RLS, for the reason
 * `docs/multi-tenancy.md` states: the policy is the backstop that makes a bug non-catastrophic,
 * and the explicit filter is what makes the bug visible.
 */

/** One day's counts. `day` is a UTC date string, so two tenants' series line up. */
export interface DailyCount {
  day: string;
  casesOpened: number;
  alertsFired: number;
}

/**
 * Daily counts over a window, with EVERY day present.
 *
 * Generated from a date series and left-joined, rather than grouping the rows that exist: a chart
 * built from present days alone draws a line straight across a week nothing happened, which reads
 * as steady activity instead of none. The gap is the fact worth seeing.
 */
export async function dailyCounts(db: Db, orgId: string, days = 14): Promise<DailyCount[]> {
  // Each source is aggregated in its OWN subquery before the join. Two independent left joins
  // off one date series build a per-day cartesian product — 200 cases and 200 events on one day is
  // 40,000 intermediate rows for two numbers, which `count(distinct …)` corrects but still pays for.
  //
  // Days are cut in UTC (`timezone('UTC', …)`), not in the session's zone: two tenants reading the
  // same chart in different zones must not disagree about which day a case landed on.
  const rows = await db.execute<{ day: string; cases_opened: string; alerts_fired: string }>(sql`
    with span as (
      select generate_series(
        (timezone('UTC', now())::date - make_interval(days => ${days - 1}))::date,
        timezone('UTC', now())::date,
        interval '1 day'
      )::date as day
    ),
    opened as (
      select timezone('UTC', opened_at)::date as day, count(*) as n
        from ${cases}
       where org_id = ${orgId}
         and opened_at >= timezone('UTC', now())::date - make_interval(days => ${days - 1})
       group by 1
    ),
    fired as (
      select timezone('UTC', fired_at)::date as day, count(*) as n
        from ${alertEvents}
       where org_id = ${orgId}
         and fired_at >= timezone('UTC', now())::date - make_interval(days => ${days - 1})
       group by 1
    )
    select to_char(span.day, 'YYYY-MM-DD') as day,
           coalesce(opened.n, 0)::text as cases_opened,
           coalesce(fired.n, 0)::text as alerts_fired
      from span
      left join opened on opened.day = span.day
      left join fired on fired.day = span.day
     order by span.day
  `);
  return rows.map((row) => ({
    day: row.day,
    casesOpened: Number(row.cases_opened),
    alertsFired: Number(row.alerts_fired),
  }));
}

/** A critical case nobody has acknowledged. */
export interface UnacknowledgedCase {
  id: string;
  workflowId: string;
  genericName: string;
  severity: string | null;
  openedAt: Date;
  /** Hours since the case opened — how long the ladder has been running with no answer. */
  hoursOpen: number;
  /**
   * The same span in MINUTES, because the ladder's first rungs are measured in them.
   *
   * Carried separately rather than derived from `hoursOpen`, which is floored for display: a case
   * twenty minutes old is "0 hours", and a ladder reading that would report nothing owed at the
   * moment its first rung came due.
   */
  minutesOpen: number;
}

/**
 * Critical cases with no acknowledgment (ticket 14).
 *
 * `severity` is the case's own, not a signal's: this is the ladder the escalation policy runs on,
 * and reading a different column here than the ladder reads would show a director a list that does
 * not match who is actually being paged.
 */
export async function unacknowledgedCritical(
  db: Db,
  orgId: string,
  limit = 20,
): Promise<UnacknowledgedCase[]> {
  // NO tier column here. This is an anti-join — the rows it returns are exactly the cases with no
  // acknowledgment — so any aggregate over `acknowledgments` is aggregating nothing and would
  // report "not yet escalated" for every row whatever the ladder actually did. What CAN be said
  // honestly is how long the case has gone unanswered, which is the number a director acts on.
  const rows = await db
    .select({
      id: cases.id,
      workflowId: cases.workflowId,
      genericName: cases.genericName,
      severity: cases.severity,
      openedAt: cases.openedAt,
      hoursOpen: sql<number>`extract(epoch from (now() - ${cases.openedAt})) / 3600`,
      minutesOpen: sql<number>`extract(epoch from (now() - ${cases.openedAt})) / 60`,
    })
    .from(cases)
    .leftJoin(
      acknowledgments,
      and(eq(acknowledgments.orgId, orgId), eq(acknowledgments.caseId, cases.id)),
    )
    .where(
      and(
        eq(cases.orgId, orgId),
        eq(cases.severity, "critical"),
        isNull(cases.closedAt),
        // No acknowledgment row at all. A case acknowledged at tier 0 has been seen by someone,
        // which is the whole question this list asks.
        isNull(acknowledgments.id),
      ),
    )
    // Oldest first: the case nobody has answered for three days is the one that matters.
    .orderBy(cases.openedAt)
    .limit(limit);
  // MINUTES ALONGSIDE HOURS, and only the hours are floored. The escalation ladder's first rungs
  // are measured in minutes, so a case twenty minutes old floored to "0 hours" reads as nothing
  // being owed at the exact point the first rung came due — the ladder would go quiet for the whole
  // first hour of every critical case, which is the hour it exists for.
  return rows.map((row) => ({
    ...row,
    hoursOpen: Math.floor(Number(row.hoursOpen)),
    minutesOpen: Math.floor(Number(row.minutesOpen)),
  }));
}

/** One page of alert history, with the rule that produced each event. */
export interface AlertHistoryOptions {
  outcome?: string;
  page: number;
  pageSize: number;
}

export interface AlertHistoryRow {
  event: AlertEventRow;
  ruleName: string | null;
}

export async function listAlertHistory(
  db: Db,
  orgId: string,
  options: AlertHistoryOptions,
): Promise<{ rows: AlertHistoryRow[]; total: number; page: number }> {
  const predicates = [eq(alertEvents.orgId, orgId)];
  if (options.outcome) predicates.push(eq(alertEvents.outcome, options.outcome));
  const where = and(...predicates);
  const [counted] = await db
    .select({ total: sql<string>`count(*)` })
    .from(alertEvents)
    .where(where);
  const total = Number(counted?.total ?? 0);
  // Both bounds, on both numbers. The console's parser already constrains what a URL can ask for,
  // but this function is exported: `pageSize: 0` would make the page count Infinity and
  // `page: 0` would reach OFFSET as a negative number.
  const pageSize = Math.max(1, Math.floor(options.pageSize));
  const page = Math.max(1, Math.min(options.page, Math.max(1, Math.ceil(total / pageSize))));
  const rows = await db
    .select({ event: alertEvents, ruleName: alertRules.name })
    .from(alertEvents)
    .leftJoin(alertRules, and(eq(alertRules.orgId, orgId), eq(alertRules.id, alertEvents.ruleId)))
    .where(where)
    // `id` last so two events fired in the same instant hold a stable order between pages.
    .orderBy(desc(alertEvents.firedAt), desc(alertEvents.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { rows, total, page };
}
