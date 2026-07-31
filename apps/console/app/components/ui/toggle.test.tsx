import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toggle } from "./toggle";

/** The two credential surfaces whose selectors this component exists to replace. */
const CALL_SITES = [
  "../../(admin)/admin/api-keys/api-keys-admin.tsx",
  "../../(admin)/admin/users/users-admin.tsx",
] as const;

/**
 * The API-key scope selectors and the role selectors are `Toggle`s, and "selected" on them is a
 * grant of authority. They were previously `className={on ? "pill" : "pill muted"}` — and `.muted`
 * is defined nowhere, so both states rendered as the same accent-filled pill and the only
 * difference between "this key may write protocols" and "it may not" was a `✓` character.
 *
 * Rendered to static markup rather than mounted: these assertions are about what the component
 * commits to the DOM and the accessibility tree, which server rendering settles completely.
 */
describe("Toggle", () => {
  it("carries its state to assistive technology with aria-pressed", () => {
    expect(renderToStaticMarkup(<Toggle pressed>read:cases</Toggle>)).toContain(
      'aria-pressed="true"',
    );
    expect(renderToStaticMarkup(<Toggle pressed={false}>read:cases</Toggle>)).toContain(
      'aria-pressed="false"',
    );
  });

  it("renders visually distinct on and off states, not one class plus a glyph", () => {
    const on = renderToStaticMarkup(<Toggle pressed>read:cases</Toggle>);
    const off = renderToStaticMarkup(<Toggle pressed={false}>read:cases</Toggle>);
    expect(on).toContain("ds-toggle--on");
    expect(off).toContain("ds-toggle--off");
    expect(on).not.toContain("ds-toggle--off");
    expect(off).not.toContain("ds-toggle--on");
  });

  it("never renders the phantom .muted class", () => {
    const off = renderToStaticMarkup(<Toggle pressed={false}>read:cases</Toggle>);
    expect(off).not.toMatch(/\bmuted\b/);
    expect(off).not.toMatch(/\bpill\b/);
  });

  it("hides the check glyph from screen readers, which already have aria-pressed", () => {
    const on = renderToStaticMarkup(<Toggle pressed>read:cases</Toggle>);
    expect(on).toMatch(/aria-hidden="true"[^>]*>✓/);
  });

  it("is always type=button, so it cannot submit a form it happens to sit in", () => {
    expect(renderToStaticMarkup(<Toggle pressed={false}>x</Toggle>)).toContain('type="button"');
  });

  // A component nobody uses fixes nothing. Both credential surfaces have to be OFF the phantom
  // class, and a grep is the honest way to say so — the alternative is mounting two client
  // components that import server actions, which drags the database into a styling assertion.
  it.each(CALL_SITES)("%s selects scopes with Toggle, not the phantom .muted pill", (site) => {
    const source = readFileSync(fileURLToPath(new URL(site, import.meta.url)), "utf8");
    expect(source).not.toContain("pill muted");
    expect(source).toContain("<Toggle");
  });
});
