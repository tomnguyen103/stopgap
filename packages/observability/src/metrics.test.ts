import { afterEach, describe, expect, it, vi } from "vitest";
import {
  counterFamilies,
  incrementCounter,
  renderPrometheus,
  resetCounters,
  type MetricFamily,
} from "./metrics.js";

/**
 * The Prometheus renderer is a PURE function of injected metric values, so it is fully testable
 * without a database or a scrape (PHASE6 §6.4). These tests pin the exposition-format bytes a
 * scraper will actually read, and the counter registry's accumulation/label behaviour.
 */

describe("renderPrometheus", () => {
  it("emits HELP/TYPE headers and label-sorted samples", () => {
    const families: MetricFamily[] = [
      {
        name: "stopgap_exception_queue_depth",
        help: "Cases parked in the exception queue.",
        type: "gauge",
        samples: [{ value: 3 }],
      },
      {
        name: "stopgap_feed_staleness_seconds",
        help: "Seconds since a source's newest record.",
        type: "gauge",
        samples: [
          { value: 12, labels: { source: "openfda" } },
          { value: 99, labels: { source: "ashp" } },
        ],
      },
    ];
    expect(renderPrometheus(families)).toBe(
      [
        "# HELP stopgap_exception_queue_depth Cases parked in the exception queue.",
        "# TYPE stopgap_exception_queue_depth gauge",
        "stopgap_exception_queue_depth 3",
        "# HELP stopgap_feed_staleness_seconds Seconds since a source's newest record.",
        "# TYPE stopgap_feed_staleness_seconds gauge",
        'stopgap_feed_staleness_seconds{source="openfda"} 12',
        'stopgap_feed_staleness_seconds{source="ashp"} 99',
        "",
      ].join("\n"),
    );
  });

  it("still emits the header for a family with no samples (metric exists, zero activity)", () => {
    const out = renderPrometheus([
      { name: "stopgap_ack_latency_seconds", help: "Avg ack latency.", type: "gauge", samples: [] },
    ]);
    expect(out).toBe("# HELP stopgap_ack_latency_seconds Avg ack latency.\n# TYPE stopgap_ack_latency_seconds gauge\n");
  });

  it("escapes special characters in label values", () => {
    const out = renderPrometheus([
      { name: "m", help: "h", type: "gauge", samples: [{ value: 1, labels: { k: 'a"b\\c' } }] },
    ]);
    expect(out).toContain('m{k="a\\"b\\\\c"} 1');
  });
});

describe("counter registry", () => {
  afterEach(() => {
    resetCounters();
  });

  it("accumulates by name + labels into one series", () => {
    incrementCounter("stopgap_comms_delivered_total", { channel: "email" });
    incrementCounter("stopgap_comms_delivered_total", { channel: "email" });
    incrementCounter("stopgap_comms_delivered_total", { channel: "ehr" });
    const families = counterFamilies();
    expect(families).toHaveLength(1);
    const family = families[0]!;
    expect(family.type).toBe("counter");
    const email = family.samples.find((s) => s.labels?.channel === "email");
    const ehr = family.samples.find((s) => s.labels?.channel === "ehr");
    expect(email?.value).toBe(2);
    expect(ehr?.value).toBe(1);
  });

  it("resetCounters clears the registry", () => {
    incrementCounter("stopgap_feed_poll_success_total");
    expect(counterFamilies()).toHaveLength(1);
    resetCounters();
    expect(counterFamilies()).toHaveLength(0);
  });
});

/**
 * `collectGaugeFamilies` is the only impure step in the scrape: it turns the DB reads into the
 * gauge families the pure renderer formats. Mocking the two data sources pins the mapping —
 * including the two cases that are easy to get wrong: an unset spend cap must surface as an
 * explicit 0 (so a dashboard can tell "no cap" from "cap not reached"), and an absent ack latency
 * must emit NO sample rather than a fabricated 0.
 */
vi.mock("@stopgap/db", () => ({
  getDb: () => ({}),
  getLlmSpend: async () => ({ usd: 1.25 }),
  getOpsMetrics: async () => ({
    casesOpenedToday: 4,
    exceptionQueueDepth: 2,
    feedStaleness: [{ source: "openfda", secondsStale: 90 }],
    ackLatencySeconds: undefined,
    criticalUnacked: { count: 3, maxAgeSeconds: 7200 },
  }),
}));
vi.mock("@stopgap/core/env", () => ({ getEnv: () => ({ LLM_DAILY_USD_CAP: undefined }) }));

describe("collectGaugeFamilies", () => {
  function sampleValue(families: MetricFamily[], name: string): number | undefined {
    return families.find((f) => f.name === name)?.samples[0]?.value;
  }

  it("maps the DB reads onto the gauge families a scraper reads", async () => {
    const { collectGaugeFamilies, collectMetricsText } = await import("./metrics.js");
    const families = await collectGaugeFamilies();

    expect(sampleValue(families, "stopgap_cases_opened_today")).toBe(4);
    expect(sampleValue(families, "stopgap_exception_queue_depth")).toBe(2);
    expect(sampleValue(families, "stopgap_llm_daily_spend_usd")).toBe(1.25);
    expect(sampleValue(families, "stopgap_critical_case_unacked_count")).toBe(3);
    expect(sampleValue(families, "stopgap_critical_case_unacked_seconds")).toBe(7200);
    // An unset cap is an explicit 0, not an absent gauge.
    expect(sampleValue(families, "stopgap_llm_daily_cap_usd")).toBe(0);
    // Nothing acked yet: no sample at all rather than a made-up zero latency.
    expect(families.find((f) => f.name === "stopgap_ack_latency_seconds")?.samples).toEqual([]);
    // Feed staleness is per-source labelled.
    expect(families.find((f) => f.name === "stopgap_feed_staleness_seconds")?.samples).toEqual([
      { value: 90, labels: { source: "openfda" } },
    ]);

    // The console scrape (gauges only) renders those same families as exposition text.
    const text = await collectMetricsText(false);
    expect(text).toContain("# TYPE stopgap_cases_opened_today gauge");
    expect(text).toContain("stopgap_cases_opened_today 4");
  });
});
