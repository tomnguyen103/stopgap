import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Card } from "./components/ui/card";
import { readGlobalsCss } from "./design-test-helpers";

/**
 * The Ledger Rail (§6).
 *
 * The claim it has to keep is that it NEVER carries meaning alone. A 2px tint is invisible to a
 * reader who cannot separate amber from grey, gone under `forced-colors`, and absent from a
 * screen reader entirely — so every card that wears one also says its state in words inside it.
 * The test that matters is therefore the negative one: the rail is decoration over a signal that
 * is already legible without it.
 */
const css = readGlobalsCss();

describe("the Ledger Rail", () => {
  it("is one pseudo-element, not an extra element in the DOM", () => {
    const html = renderToStaticMarkup(<Card state="critical">body</Card>);
    // Exactly the section the card has always rendered, plus an attribute.
    expect(html).toContain('data-state="critical"');
    expect(html.match(/<div/g) ?? []).toHaveLength(0);
  });

  it("adds no attribute at all when a card has no state to report", () => {
    // A rail on every card is a rail that says nothing. The untinted default is a hairline.
    expect(renderToStaticMarkup(<Card>body</Card>)).not.toContain("data-state");
  });

  it("draws the rail from a custom property with a hairline fallback", () => {
    expect(css).toMatch(
      /\.ds-card::before\s*\{[^}]*background:\s*var\(--rail, var\(--line-default\)\)/,
    );
  });

  it.each([
    ["critical", "--severity-critical"],
    ["attention", "--severity-high"],
    ["ok", "--status-ok"],
  ])("tints a %s card from %s", (state, token) => {
    expect(css).toMatch(
      new RegExp(`\\.ds-card\\[data-state="${state}"\\]\\s*\\{\\s*--rail: var\\(${token}\\)`),
    );
  });

  it("carries the same rail onto a state-bearing table row", () => {
    // A `tr` cannot host an absolutely-positioned pseudo-element reliably, so the first cell does.
    expect(css).toMatch(/\.ds-table tr\[data-state\] td:first-child\s*\{\s*position: relative/);
  });

  it("keeps the nav's current-page rail achromatic", () => {
    // Navigation is not a clinical state. If the current route were tinted from the severity ramp
    // it would compete with the one thing this console reserves colour for.
    expect(css).toMatch(/\.rail__item\[aria-current="page"\]\s*\{[^}]*--rail: var\(--pt-900\)/);
  });
});
