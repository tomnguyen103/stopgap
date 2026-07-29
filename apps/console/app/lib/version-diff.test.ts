import { describe, expect, it } from "vitest";

import { diffLines, summarizeDiff } from "./version-diff.js";

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
