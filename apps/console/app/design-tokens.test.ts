import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The token graph, resolved and measured.
 *
 * Two things a stylesheet cannot tell you by reading it. First, what a semantic name actually
 * evaluates to — `--surface-hover` is three `var()` hops from a hex, and a ramp can silently
 * invert without any single line looking wrong. Second, whether the result is legible: contrast
 * is a property of a PAIR, so no declaration can carry it.
 *
 * Both are asserted here rather than eyeballed, because §9 of the design direction requires a
 * contrast audit and an audit nobody can re-run is a claim, not a check.
 */
const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** The `:root` block only — component-scoped overrides are variants, not the palette. */
function rootDeclarations(source: string): Map<string, string> {
  const block = /:root\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  const out = new Map<string, string>();
  for (const line of block.split("\n")) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], m[2].trim());
  }
  return out;
}

const TOKENS = rootDeclarations(css);

/** Follows `var()` hops until a literal falls out. Throws on a cycle rather than hanging. */
function resolve(name: string, seen = new Set<string>()): string {
  if (seen.has(name)) throw new Error(`cycle through ${name}`);
  seen.add(name);
  const value = TOKENS.get(name);
  if (value === undefined) throw new Error(`${name} is not defined in :root`);
  const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(value);
  return ref?.[1] ? resolve(ref[1], seen) : value;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) throw new Error(`not a six-digit hex: ${hex}`);
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const round = (n: number) => Math.round(n * 100) / 100;

describe("the surface ladder", () => {
  // Depth in a dark UI is read from lightness. If a surface that is meant to sit ON another is
  // darker than it, the two swap places optically however correct each hex is on its own.
  it("puts a raised surface above the page", () => {
    expect(luminance(resolve("--surface-raised"))).toBeGreaterThan(
      luminance(resolve("--surface-page")),
    );
  });

  it("puts a hovered row above the card it sits inside", () => {
    expect(luminance(resolve("--surface-hover"))).toBeGreaterThan(
      luminance(resolve("--surface-raised")),
    );
  });

  it("puts an overlay above a card, because it floats over one", () => {
    expect(luminance(resolve("--surface-overlay"))).toBeGreaterThan(
      luminance(resolve("--surface-raised")),
    );
  });

  it("puts a selected fill above a hovered one", () => {
    expect(luminance(resolve("--surface-selected"))).toBeGreaterThan(
      luminance(resolve("--surface-hover")),
    );
  });
});

describe("contrast", () => {
  const SURFACES = ["--surface-page", "--surface-raised", "--surface-sunken", "--surface-hover"];

  it.each(SURFACES)("body text clears 4.5:1 on %s", (surface) => {
    expect(round(contrast(resolve("--text-default"), resolve(surface)))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it.each(SURFACES)("subtle text clears 4.5:1 on %s", (surface) => {
    expect(round(contrast(resolve("--text-subtle"), resolve(surface)))).toBeGreaterThanOrEqual(4.5);
  });

  // Non-text indicators are the 3:1 band: the four severity steps, the two status states, and the
  // focus ring, each against the surface it is drawn on.
  it.each([
    "--severity-critical",
    "--severity-high",
    "--severity-moderate",
    "--severity-low",
    "--status-ok",
    "--focus-ring",
  ])("%s clears 3:1 against a raised surface", (token) => {
    expect(round(contrast(resolve(token), resolve("--surface-raised")))).toBeGreaterThanOrEqual(3);
  });

  it("keeps a primary button's label legible on its own fill", () => {
    expect(
      round(contrast(resolve("--text-on-accent"), resolve("--interactive"))),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
