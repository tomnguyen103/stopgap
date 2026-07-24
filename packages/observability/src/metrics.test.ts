import { afterEach, describe, expect, it } from "vitest";
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
