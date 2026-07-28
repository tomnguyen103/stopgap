import { describe, expect, it } from "vitest";
import { BURN_WINDOW_DAYS, summarizeExposure, type ExposureFacts } from "./matching.js";

/**
 * Turning catalog rows into the two figures the scorer consumes (ticket 16).
 *
 * The fetching needs Postgres; this does not, and this is where the judgement lives — which
 * snapshot counts, what a burn rate is, and whose exposure a set of matched items reports.
 */

const AT = new Date("2026-07-28T00:00:00.000Z");
const earlier = new Date("2026-07-01T00:00:00.000Z");

/** `q` units ordered over the whole window is exactly `q / 90` a day. */
const perDay = (days: number, onHand: number) => (onHand / days) * BURN_WINDOW_DAYS;

function facts(over: Partial<ExposureFacts> = {}): ExposureFacts {
  return { stock: [], burn: [], links: [], ...over };
}

describe("summarizeExposure — days on hand", () => {
  it("divides stock by the trailing burn rate", () => {
    const reading = summarizeExposure(
      facts({
        stock: [{ itemId: "a", facilityId: "f1", onHand: 100, capturedAt: AT }],
        burn: [{ itemId: "a", quantity: perDay(10, 100) }],
      }),
      ["a"],
    );
    expect(reading.daysOnHand).toBe(10);
  });

  it("reads only the LATEST snapshot per facility, never the history", () => {
    const reading = summarizeExposure(
      facts({
        stock: [
          { itemId: "a", facilityId: "f1", onHand: 900, capturedAt: earlier },
          { itemId: "a", facilityId: "f1", onHand: 100, capturedAt: AT },
        ],
        burn: [{ itemId: "a", quantity: perDay(10, 100) }],
      }),
      ["a"],
    );
    // Summing the two counts would report 100 days of stock on a shelf holding ten.
    expect(reading.daysOnHand).toBe(10);
  });

  it("sums the latest count ACROSS facilities — same item, same unit", () => {
    const reading = summarizeExposure(
      facts({
        stock: [
          { itemId: "a", facilityId: "f1", onHand: 60, capturedAt: AT },
          { itemId: "a", facilityId: "f2", onHand: 40, capturedAt: AT },
        ],
        burn: [{ itemId: "a", quantity: perDay(10, 100) }],
      }),
      ["a"],
    );
    expect(reading.daysOnHand).toBe(10);
  });

  it("reports the WORST-supplied item, never a cross-item average", () => {
    const reading = summarizeExposure(
      facts({
        stock: [
          { itemId: "plenty", facilityId: "f1", onHand: 1000, capturedAt: AT },
          { itemId: "scarce", facilityId: "f1", onHand: 2, capturedAt: AT },
        ],
        burn: [
          { itemId: "plenty", quantity: perDay(100, 1000) },
          { itemId: "scarce", quantity: perDay(2, 2) },
        ],
      }),
      ["plenty", "scarce"],
    );
    // Vials and cases are not addable, and a facility two days from running out of one matched
    // presentation is exposed however well stocked the others are.
    expect(reading.daysOnHand).toBe(2);
  });

  it("is ABSENT, not zero, with no purchasing history to read a burn rate from", () => {
    const reading = summarizeExposure(
      facts({ stock: [{ itemId: "a", facilityId: "f1", onHand: 100, capturedAt: AT }] }),
      ["a"],
    );
    // "0 days" for an item nobody orders would say the facility is about to run out of something
    // it never uses.
    expect(reading.daysOnHand).toBeUndefined();
  });

  it("is absent with a burn rate but no stock count", () => {
    const reading = summarizeExposure(facts({ burn: [{ itemId: "a", quantity: 900 }] }), ["a"]);
    expect(reading.daysOnHand).toBeUndefined();
  });

  it("ignores rows for items this signal did not match", () => {
    const reading = summarizeExposure(
      facts({
        stock: [{ itemId: "other", facilityId: "f1", onHand: 1, capturedAt: AT }],
        burn: [{ itemId: "other", quantity: 9000 }],
      }),
      ["a"],
    );
    expect(reading.daysOnHand).toBeUndefined();
  });
});

describe("summarizeExposure — supply", () => {
  it("reports the sites behind the WORST-supplied item, not the union", () => {
    const reading = summarizeExposure(
      facts({
        links: [
          { itemId: "a", siteId: "s1", supplierId: "v1" },
          { itemId: "b", siteId: "s2", supplierId: "v2" },
          { itemId: "c", siteId: "s3", supplierId: "v3" },
        ],
      }),
      ["a", "b", "c"],
    );
    // Three items each sole-sourced from a different depot is three separate single points of
    // failure. A union of 3 would score it as comfortably supplied — diluting sole-source risk
    // exactly when it is worst.
    expect(reading.supplierSiteCount).toBe(1);
    expect(reading.soleSourcedItemIds).toEqual(["a", "b", "c"]);
  });

  it("counts distinct sites for one item", () => {
    const reading = summarizeExposure(
      facts({
        links: [
          { itemId: "a", siteId: "s1", supplierId: "v1" },
          { itemId: "a", siteId: "s2", supplierId: "v1" },
          { itemId: "a", siteId: "s1", supplierId: "v1" },
        ],
      }),
      ["a"],
    );
    expect(reading.supplierSiteCount).toBe(2);
    expect(reading.soleSourcedItemIds).toEqual([]);
  });

  it("treats a link with no named site as one source of supply, not none", () => {
    // The file did not say WHICH depot; it did say there is a supplier.
    const reading = summarizeExposure(
      facts({ links: [{ itemId: "a", siteId: null, supplierId: "v1" }] }),
      ["a"],
    );
    expect(reading.supplierSiteCount).toBe(1);
    expect(reading.soleSourcedItemIds).toEqual(["a"]);
  });

  it("distinguishes two unnamed sites at DIFFERENT suppliers", () => {
    const reading = summarizeExposure(
      facts({
        links: [
          { itemId: "a", siteId: null, supplierId: "v1" },
          { itemId: "a", siteId: null, supplierId: "v2" },
        ],
      }),
      ["a"],
    );
    expect(reading.supplierSiteCount).toBe(2);
  });

  it("is ABSENT, not zero, when no supplier link is recorded", () => {
    const reading = summarizeExposure(facts(), ["a"]);
    expect(reading.supplierSiteCount).toBeUndefined();
    expect(reading.soleSourcedItemIds).toEqual([]);
  });

  it("returns nothing at all for a signal that matched nothing", () => {
    expect(summarizeExposure(facts(), [])).toEqual({
      daysOnHand: undefined,
      supplierSiteCount: undefined,
      soleSourcedItemIds: [],
    });
  });
});
