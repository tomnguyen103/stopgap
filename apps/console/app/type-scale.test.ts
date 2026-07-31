import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/**
 * Every declaration that lands on a selector, concatenated.
 *
 * All of them, not the first match: a selector can appear alone and again inside a group, and
 * `.ds-table td` is written both ways. Reading only the first would let a later rule quietly
 * satisfy or contradict the assertion without the test noticing either way.
 */
function rule(selector: string): string {
  const blocks: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selectors = (match[1] ?? "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((s) => s.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? "");
  }
  if (blocks.length === 0) throw new Error(`no rule for ${selector}`);
  return blocks.join("\n");
}

describe("the type scale", () => {
  it.each([
    ["--text-display", "32px"],
    ["--text-title", "22px"],
    ["--text-heading", "16px"],
    ["--text-subhead", "14px"],
    ["--text-body", "14px"],
    ["--text-small", "13px"],
    ["--text-micro", "11px"],
  ])("defines %s as %s", (token, value) => {
    expect(css).toMatch(new RegExp(`${token}:\\s*${value};`));
  });

  it("has a display step far enough above body to be a different kind of thing", () => {
    // The old scale ran 12/13/15 plus one 28px figure: a KPI and a table cell were one step
    // apart, so nothing on a page could be the headline. Numbers are what this product sells.
    const display = Number(/--text-display:\s*(\d+)px/.exec(css)?.[1]);
    const body = Number(/--text-body:\s*(\d+)px/.exec(css)?.[1]);
    expect(display / body).toBeGreaterThanOrEqual(2);
  });
});

describe("numerals", () => {
  it("defines tabular, slashed-zero figures once", () => {
    expect(css).toMatch(/--font-numeric:\s*tabular-nums slashed-zero;/);
  });

  it.each([".ds-table td", ".ds-figure__value"])(
    "%s reads the numeric token rather than restating it",
    (selector) => {
      expect(rule(selector)).toContain("font-variant-numeric: var(--font-numeric)");
    },
  );
});

describe("monospace", () => {
  // Mono is for identifiers — ids, hashes, key prefixes, NDCs. A clinical protocol a pharmacist
  // wrote, set in a monospaced face, reads as machine output, which is the opposite of what it is.
  it.each([".draft", ".draft-input", ".reason-input", ".ds-input"])(
    "%s sets human prose in the body face, not the mono one",
    (selector) => {
      expect(rule(selector)).not.toContain("--font-mono");
    },
  );

  it("still sets identifiers in mono", () => {
    expect(rule(".mono")).toContain("--font-mono");
  });
});
