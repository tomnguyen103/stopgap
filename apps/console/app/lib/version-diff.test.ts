import { describe, expect, it } from "vitest";

import { diffLines, parseVersionParam, resolveComparison, summarizeDiff } from "./version-diff.js";

describe("protocol version diff", () => {
  it("reports an unchanged body as unchanged", () => {
    const body = "Substitute cefazolin 1g.\nMonitor renal function.";
    expect(diffLines(body, body).every((line) => line.kind === "unchanged")).toBe(true);
    expect(summarizeDiff(diffLines(body, body))).toBe("no textual change");
  });

  it("does not report a trailing newline as a change", () => {
    // Appending one is the single most common no-op edit; reporting it would teach a director to
    // ignore the summary.
    expect(summarizeDiff(diffLines("Give 1g.", "Give 1g.\n"))).toBe("no textual change");
  });

  it("names an inserted line without disturbing the ones around it", () => {
    const diff = diffLines("A\nC", "A\nB\nC");
    expect(diff.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "unchanged:A",
      "added:B",
      "unchanged:C",
    ]);
    expect(summarizeDiff(diff)).toBe("1 line added");
  });

  it("reports a replaced line as one removal and one addition", () => {
    const diff = diffLines("Dose 1g q8h.", "Dose 2g q8h.");
    expect(diff.map((line) => line.kind)).toEqual(["removed", "added"]);
    expect(summarizeDiff(diff)).toBe("1 line added, 1 line removed");
  });

  it("handles a first version, where there is nothing to compare against", () => {
    const diff = diffLines("", "Only guidance.");
    expect(diff).toEqual([{ kind: "added", text: "Only guidance." }]);
    expect(summarizeDiff(diff)).toBe("1 line added");
  });

  it("normalises CRLF, so a Windows-authored edit is not a whole-file rewrite", () => {
    expect(summarizeDiff(diffLines("A\nB", "A\r\nB"))).toBe("no textual change");
  });
});

describe("resolveComparison", () => {
  const versions = [{ version: 3 }, { version: 2 }, { version: 1 }];
  const req = (
    over: Partial<{ compare: string | null; from: number | null; to: number | null }>,
  ) => ({
    compare: "heparin",
    from: 1,
    to: 3,
    ...over,
  });

  it("resolves the pair the address names", () => {
    expect(resolveComparison(versions, "heparin", req({}))).toEqual({
      from: { version: 1 },
      to: { version: 3 },
    });
  });

  it("compares any two versions, not only a version against the one before it", () => {
    // "What has changed since the version we agreed in March" is the question asked in an incident
    // review, and it is not answerable by consecutive diffs alone.
    expect(resolveComparison(versions, "heparin", req({ from: 1, to: 2 }))).toEqual({
      from: { version: 1 },
      to: { version: 2 },
    });
  });

  it("ignores a request naming a different protocol", () => {
    // Otherwise one card's comparison renders on every card on the page.
    expect(resolveComparison(versions, "cefazolin", req({}))).toBeNull();
  });

  it("falls back to no comparison when a version does not exist", () => {
    // A hand-edited or stale link names v99. Erroring would break the page; picking a nearby
    // version would show a diff nobody asked for under the numbers they did.
    expect(resolveComparison(versions, "heparin", req({ to: 99 }))).toBeNull();
    expect(resolveComparison(versions, "heparin", req({ from: null }))).toBeNull();
  });

  it("compares a version with itself without complaint", () => {
    // Selecting the same version twice is a legal thing to ask for; the answer is an empty diff.
    expect(resolveComparison(versions, "heparin", req({ from: 2, to: 2 }))).toEqual({
      from: { version: 2 },
      to: { version: 2 },
    });
  });
});

describe("parseVersionParam", () => {
  it("takes a version number and rejects everything else", () => {
    expect(parseVersionParam("3")).toBe(3);
    expect(parseVersionParam(undefined)).toBeNull();
    expect(parseVersionParam(["3", "4"])).toBeNull();
    expect(parseVersionParam("3.5")).toBeNull();
    expect(parseVersionParam("not-a-number")).toBeNull();
    expect(parseVersionParam("1e999")).toBeNull();
  });
});
