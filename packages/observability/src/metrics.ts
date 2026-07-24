import { getEnv } from "@stopgap/core/env";
import { getDb, getLlmSpend, getOpsMetrics } from "@stopgap/db";

/**
 * Prometheus metrics (PHASE6 §6.4), hand-rolled rather than pulled from a heavy exporter lib.
 *
 * Two kinds of metric, split by what can honestly be derived on scrape:
 *  - GAUGES are computed from the durable tables ON SCRAPE (`collectGaugeFamilies`). A gauge read
 *    from the source of truth cannot drift when a process dies mid-update — the same reason the
 *    KPI page reads the DB instead of a counter.
 *  - COUNTERS are event-driven monotonic totals (comms sent, task failures, polls) that no query
 *    can reconstruct after the fact, so they live in-process and are incremented where the event
 *    happens (the worker). They are exposed only on the worker's `/metrics` sidecar.
 *
 * The renderer is a PURE function tested without a database by injecting the metric values; the
 * console route and the worker sidecar both call `collectGaugeFamilies` and render its output, so
 * the Prometheus text format lives in exactly one place. Deliberately dependency-light so it can
 * run inside a Next.js node route handler without dragging OTel into the console bundle.
 */

export type MetricType = "gauge" | "counter";

export interface MetricSample {
  value: number;
  labels?: Record<string, string>;
}

export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

/** Escape a label value per the Prometheus exposition format (backslash, quote, newline). */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render `{k="v",...}` with keys sorted so the same sample always serialises identically. */
function renderLabels(labels: Record<string, string> | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",")}}`;
}

/**
 * Render metric families to Prometheus text exposition format. Pure — no DB, no clock — so a test
 * can assert the exact output for a known set of values. A family with no samples still emits its
 * HELP/TYPE header (so a scrape of a fresh process shows the metric exists at 0 activity).
 */
export function renderPrometheus(families: MetricFamily[]): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${family.help}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) {
      lines.push(`${family.name}${renderLabels(sample.labels)} ${String(sample.value)}`);
    }
  }
  // Prometheus requires a trailing newline.
  return `${lines.join("\n")}\n`;
}

// ---- Event-driven counters (worker process) ---------------------------------------------------

/** Help text for each known counter, so a first-seen increment carries a description. */
const COUNTER_HELP: Record<string, string> = {
  stopgap_comms_delivered_total: "Outbound comms messages that a transport actually delivered.",
  stopgap_comms_nondelivered_total: "Outbound comms messages recorded as non-delivered (no credentials, transport error).",
  stopgap_feed_poll_success_total: "Feed-poll workflow runs that completed successfully.",
  stopgap_workflow_task_failures_total: "Activity executions that threw (before Temporal retry).",
};

interface CounterEntry {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** In-process counter registry, keyed by name + sorted labels so one series accumulates. */
const counters = new Map<string, CounterEntry>();

function counterKey(name: string, labels: Record<string, string>): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ""}`);
  return `${name}|${parts.join(",")}`;
}

/**
 * Increment an event-driven counter. Called from the worker's activities at the moment the event
 * happens (a comms send returns, a poll succeeds, an activity throws). Unknown-name safe: a metric
 * with no registered help still exports with a generic description rather than being dropped.
 */
export function incrementCounter(
  name: string,
  labels: Record<string, string> = {},
  by = 1,
): void {
  const key = counterKey(name, labels);
  const existing = counters.get(key);
  if (existing) existing.value += by;
  else counters.set(key, { name, labels, value: by });
}

/** The registered counters as metric families (worker `/metrics` only). */
export function counterFamilies(): MetricFamily[] {
  const byName = new Map<string, MetricFamily>();
  for (const entry of counters.values()) {
    let family = byName.get(entry.name);
    if (!family) {
      family = {
        name: entry.name,
        help: COUNTER_HELP[entry.name] ?? "Stopgap counter.",
        type: "counter",
        samples: [],
      };
      byName.set(entry.name, family);
    }
    family.samples.push({ value: entry.value, labels: entry.labels });
  }
  return [...byName.values()];
}

/** Test helper: clear the counter registry so one test's increments don't leak into the next. */
export function resetCounters(): void {
  counters.clear();
}

// ---- DB-derived gauges (computed on scrape) ---------------------------------------------------

/**
 * Build the gauge families from the durable tables + today's spend. Async because it queries the
 * database on every scrape — that is the point: the numbers are always the current truth, never a
 * cached counter. Used by BOTH the console `/api/metrics` route and the worker sidecar.
 */
export async function collectGaugeFamilies(): Promise<MetricFamily[]> {
  const ops = await getOpsMetrics();
  const spend = await getLlmSpend(getDb());
  // Unset cap → 0, so a dashboard/alert can distinguish "no cap configured" from "cap not yet
  // reached" (the SpendOver80PctCap alert guards on cap > 0 for exactly this reason).
  const capUsd = getEnv().LLM_DAILY_USD_CAP ?? 0;

  return [
    {
      name: "stopgap_cases_opened_today",
      help: "Cases opened on the current UTC day.",
      type: "gauge",
      samples: [{ value: ops.casesOpenedToday }],
    },
    {
      name: "stopgap_exception_queue_depth",
      help: "Cases parked in the exception queue awaiting a human.",
      type: "gauge",
      samples: [{ value: ops.exceptionQueueDepth }],
    },
    {
      name: "stopgap_feed_staleness_seconds",
      help: "Seconds since a source's newest stored feed record.",
      type: "gauge",
      samples: ops.feedStaleness.map((f) => ({ value: f.secondsStale, labels: { source: f.source } })),
    },
    {
      name: "stopgap_llm_daily_spend_usd",
      help: "LLM spend accumulated on the current UTC day, in USD.",
      type: "gauge",
      samples: [{ value: spend.usd }],
    },
    {
      name: "stopgap_llm_daily_cap_usd",
      help: "Configured daily LLM spend cap in USD (0 when no cap is configured).",
      type: "gauge",
      samples: [{ value: capUsd }],
    },
    {
      name: "stopgap_ack_latency_seconds",
      help: "Average seconds from case open to first acknowledgment (absent when nothing acked).",
      type: "gauge",
      samples: ops.ackLatencySeconds === undefined ? [] : [{ value: ops.ackLatencySeconds }],
    },
    {
      name: "stopgap_critical_case_unacked_seconds",
      help: "Age in seconds of the oldest unacknowledged critical case (0 when none).",
      type: "gauge",
      samples: [{ value: ops.criticalUnacked.maxAgeSeconds }],
    },
    {
      name: "stopgap_critical_case_unacked_count",
      help: "Open critical cases with no acknowledgment.",
      type: "gauge",
      samples: [{ value: ops.criticalUnacked.count }],
    },
  ];
}

/**
 * The full metrics scrape as Prometheus text. `includeCounters` is true on the worker (which owns
 * the event-driven counters) and false on the console (DB gauges only), so each surface exposes
 * exactly what it can honestly report.
 */
export async function collectMetricsText(includeCounters: boolean): Promise<string> {
  const gauges = await collectGaugeFamilies();
  return renderPrometheus(includeCounters ? [...gauges, ...counterFamilies()] : gauges);
}
