import { sql } from "drizzle-orm";
import { getDb } from "./client.js";

/**
 * Operational gauges for the Prometheus scrape (PHASE6 §6.4). Like `metrics.ts` (the KPI
 * aggregates), every number here is derived from the durable tables ON SCRAPE rather than from a
 * counter incremented in application code: a gauge computed from the source of truth cannot drift
 * when a process dies mid-update, which is exactly the property a health dashboard needs. The
 * event-driven counters (comms delivery, task failures) that a gauge genuinely cannot express
 * live in the worker process instead (see `@stopgap/observability`'s metrics module).
 *
 * Returned as plain numbers/arrays, not Prometheus text: rendering is the observability layer's
 * job and is unit-tested there without a database. This module only knows SQL.
 */
export interface OpsMetrics {
  /** Cases whose `openedAt` falls on the current UTC day. */
  casesOpenedToday: number;
  /** Cases parked in the exception queue right now — the human-review backlog depth. */
  exceptionQueueDepth: number;
  /** Seconds since each source's newest stored feed record (staleness). Absent source = omitted. */
  feedStaleness: { source: string; secondsStale: number }[];
  /** Average seconds from case open to its acknowledgment, over acked cases; undefined if none. */
  ackLatencySeconds: number | undefined;
  /** Critical cases still open with no acknowledgment: how many, and the oldest one's age. */
  criticalUnacked: { count: number; maxAgeSeconds: number };
}

export async function getOpsMetrics(): Promise<OpsMetrics> {
  const db = getDb();

  // One round trip for the case-derived scalars. `date_trunc('day', now() at time zone 'utc')`
  // matches the UTC-day convention the spend ledger already uses, so "opened today" means the
  // same calendar day everywhere regardless of the database's timezone setting.
  const [caseAgg] = await db.execute<{
    opened_today: string;
    exception_depth: string;
    critical_unacked_count: string;
    critical_unacked_max_age: string | null;
  }>(sql`
    select
      count(*) filter (
        where (opened_at at time zone 'utc') >= date_trunc('day', now() at time zone 'utc')
      ) as opened_today,
      count(*) filter (where status = 'exception') as exception_depth,
      count(*) filter (
        where severity = 'critical'
          and status not in ('closed', 'rejected')
          and not exists (select 1 from acknowledgments a where a.case_id = cases.id)
      ) as critical_unacked_count,
      max(
        case
          when severity = 'critical'
            and status not in ('closed', 'rejected')
            and not exists (select 1 from acknowledgments a where a.case_id = cases.id)
          then extract(epoch from (now() - opened_at))
        end
      ) as critical_unacked_max_age
    from cases
  `);

  const feed = await db.execute<{ source: string; seconds_stale: string }>(sql`
    select source, extract(epoch from (now() - max(fetched_at))) as seconds_stale
    from feed_records
    group by source
  `);

  // Ack latency from acknowledgments joined to the case they acked. `min(ack_at)` per case so a
  // case escalated and acked at several tiers counts one latency (the first human response), not
  // one per tier.
  const [ackAgg] = await db.execute<{ avg_seconds: string | null }>(sql`
    with first_ack as (
      select case_id, min(ack_at) as ack_at from acknowledgments group by case_id
    )
    select avg(extract(epoch from (first_ack.ack_at - cases.opened_at))) as avg_seconds
    from first_ack
    join cases on cases.id = first_ack.case_id
    where first_ack.ack_at >= cases.opened_at
  `);

  return {
    casesOpenedToday: Number(caseAgg?.opened_today ?? 0),
    exceptionQueueDepth: Number(caseAgg?.exception_depth ?? 0),
    feedStaleness: feed.map((r) => ({ source: r.source, secondsStale: Number(r.seconds_stale) })),
    ackLatencySeconds: ackAgg?.avg_seconds == null ? undefined : Number(ackAgg.avg_seconds),
    criticalUnacked: {
      count: Number(caseAgg?.critical_unacked_count ?? 0),
      maxAgeSeconds: caseAgg?.critical_unacked_max_age == null ? 0 : Number(caseAgg.critical_unacked_max_age),
    },
  };
}
