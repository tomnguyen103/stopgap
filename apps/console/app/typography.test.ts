import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readGlobalsCss } from "./design-test-helpers";

/**
 * The type layer, asserted at its two seams.
 *
 * The console is documented as deployable inside hospital networks, and the API-docs route already
 * refuses a CDN dependency for that reason. A webfont fetched from a Google host would reintroduce
 * it in the one place a pharmacist notices — as unstyled text on a page they opened under time
 * pressure. `next/font` self-hosts and inlines, so the assertion worth making is that the font
 * arrives through it and that no rule bypasses the token to restate a family literal.
 */
const css = readGlobalsCss();
const layout = readFileSync(fileURLToPath(new URL("./layout.tsx", import.meta.url)), "utf8");

describe("typography", () => {
  it("loads both faces through next/font, not from a CDN", () => {
    expect(layout).toContain("geist/font/sans");
    expect(layout).toContain("geist/font/mono");
    expect(css).not.toMatch(/@import\s+url|fonts\.googleapis|fonts\.gstatic/);
  });

  it("puts the loaded faces on the document, where every rule can inherit them", () => {
    expect(layout).toContain("GeistSans.variable");
    expect(layout).toContain("GeistMono.variable");
  });

  it("routes both families through the token layer", () => {
    expect(css).toMatch(/--font-body:[^;]*--font-geist-sans/);
    expect(css).toMatch(/--font-mono:[^;]*--font-geist-mono/);
  });

  it("keeps a system fallback behind each, so a failed load is still readable", () => {
    expect(css).toMatch(/--font-body:[^;]*system-ui/);
    expect(css).toMatch(/--font-mono:[^;]*ui-monospace/);
  });

  it("has no rule restating a font family instead of reading the token", () => {
    // `body` used to carry a 14px/1.5 literal with the whole stack spelled out again — the one
    // place the three-layer token system was bypassed outright.
    const literals = css.match(/font(?:-family)?:[^;]*\bui-sans-serif\b[^;]*;/g) ?? [];
    expect(literals.filter((rule) => !rule.includes("--font-body"))).toEqual([]);
  });
});
