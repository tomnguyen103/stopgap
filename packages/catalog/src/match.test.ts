import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_CONFIDENCE } from "@stopgap/ingest";
import { matchSignalToItems, type MatchCandidate } from "./match.js";

/**
 * Signal-to-catalog matching (ticket 16). Pure, so every case here is exact rather than indicative.
 */

const hints = (over: Partial<{ ndcs: string[]; rxcuis: string[]; names: string[] }> = {}) => ({
  ndcs: [],
  rxcuis: [],
  names: [],
  ...over,
});

const item = (over: Partial<MatchCandidate> & { itemId: string }): MatchCandidate => ({
  identifiers: [],
  name: "Item",
  genericName: null,
  ...over,
});

describe("matchSignalToItems", () => {
  it("matches on NDC regardless of punctuation and case", () => {
    const matches = matchSignalToItems(hints({ ndcs: ["0409-1234-56"] }), [
      item({ itemId: "a", identifiers: [{ type: "ndc", value: "04091234 56" }] }),
    ]);
    expect(matches).toEqual([
      { itemId: "a", basis: "identifier", identifierType: "ndc", confidence: 1 },
    ]);
  });

  it("matches on RxCUI", () => {
    const matches = matchSignalToItems(hints({ rxcuis: ["197361"] }), [
      item({ itemId: "a", identifiers: [{ type: "rxcui", value: "197361" }] }),
    ]);
    expect(matches[0]?.identifierType).toBe("rxcui");
  });

  it("ignores identifier types no feed emits, rather than matching them by accident", () => {
    // `gtin`, `hibc` and `sku` are in the catalog vocabulary but never in a signal's hints. A GTIN
    // that happened to equal an NDC string must not produce a match on the strength of that.
    const matches = matchSignalToItems(hints({ ndcs: ["04091234"] }), [
      item({ itemId: "a", identifiers: [{ type: "gtin", value: "04091234" }] }),
    ]);
    expect(matches).toEqual([]);
  });

  it("falls back to the name, at the SHARED default confidence", () => {
    const matches = matchSignalToItems(hints({ names: ["Cefazolin"] }), [
      item({ itemId: "a", name: "cefazolin" }),
    ]);
    expect(matches).toEqual([{ itemId: "a", basis: "name", confidence: DEFAULT_SIGNAL_CONFIDENCE }]);
    // The constant is imported, never copied: a drift between matching's confidence and the
    // scorer's produces numbers that are plausible and wrong.
    expect(matches[0]?.confidence).toBe(DEFAULT_SIGNAL_CONFIDENCE);
  });

  it("matches the generic name as well as the facility's own name", () => {
    const matches = matchSignalToItems(hints({ names: ["heparin sodium"] }), [
      item({ itemId: "a", name: "HEPARIN 5000U/ML VIAL", genericName: "Heparin Sodium" }),
    ]);
    expect(matches[0]?.basis).toBe("name");
  });

  it("never returns a name match for an item an identifier already matched", () => {
    const matches = matchSignalToItems(hints({ ndcs: ["0409-1234-56"], names: ["cefazolin"] }), [
      item({
        itemId: "a",
        name: "cefazolin",
        identifiers: [{ type: "ndc", value: "0409123456" }],
      }),
    ]);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.basis).toBe("identifier");
  });

  it("returns nothing when neither a code nor a name lines up", () => {
    expect(
      matchSignalToItems(hints({ ndcs: ["0409-1234-56"], names: ["cefazolin"] }), [
        item({ itemId: "a", name: "vancomycin", identifiers: [{ type: "ndc", value: "999" }] }),
      ]),
    ).toEqual([]);
  });

  it("orders identifier matches ahead of name matches, deterministically", () => {
    const matches = matchSignalToItems(hints({ ndcs: ["111"], names: ["cefazolin"] }), [
      item({ itemId: "z-name", name: "cefazolin" }),
      item({ itemId: "b-code", identifiers: [{ type: "ndc", value: "111" }] }),
      item({ itemId: "a-name", name: "Cefazolin" }),
    ]);
    // Same catalog, same order, every run — a score computed from this list has to be reproducible.
    expect(matches.map((m) => m.itemId)).toEqual(["b-code", "a-name", "z-name"]);
  });

  it("treats empty hints as no match rather than as a wildcard", () => {
    expect(matchSignalToItems(hints(), [item({ itemId: "a", name: "cefazolin" })])).toEqual([]);
  });

  it("does not match on an empty stored identifier or a blank name", () => {
    expect(
      matchSignalToItems(hints({ ndcs: [""], names: [""] }), [
        item({ itemId: "a", name: "", identifiers: [{ type: "ndc", value: "" }] }),
      ]),
    ).toEqual([]);
  });
});
