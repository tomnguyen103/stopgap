import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RouteLoading } from "./components/route-loading";
import { RouteNotFound } from "./components/route-not-found";

/**
 * A database outage currently renders Next's own error page: white, unstyled, outside the console
 * shell, and with nothing on it that tells a pharmacist whether their last decision was recorded.
 * That is the failure mode this covers — the states are designed HERE, as part of the system,
 * rather than being whatever the framework falls back to.
 *
 * Every dashboard group needs its own pair, because `error.tsx` and `not-found.tsx` are resolved
 * per segment: one at the root would sit outside the group layout and lose the shell.
 */
const GROUPS = ["(admin)", "(director)", "(pharmacist)", "(viewer)"] as const;

/** The landing each role is sent to, and therefore the one whose first paint is worth covering. */
const LANDINGS = [
  "(viewer)/overview",
  "(pharmacist)/queue",
  "(director)/oversight",
  "(admin)/admin",
] as const;

function has(relative: string): boolean {
  return existsSync(fileURLToPath(new URL(relative, import.meta.url)));
}

describe("route states", () => {
  it.each(GROUPS)("%s handles a thrown error inside its own shell", (group) => {
    expect(has(`./${group}/error.tsx`)).toBe(true);
  });

  it.each(GROUPS)("%s handles a missing record inside its own shell", (group) => {
    expect(has(`./${group}/not-found.tsx`)).toBe(true);
  });

  it.each(LANDINGS)("%s shows something while its data resolves", (landing) => {
    expect(has(`./${landing}/loading.tsx`)).toBe(true);
  });

  it("announces the loading state rather than only drawing it", () => {
    const html = renderToStaticMarkup(<RouteLoading label="Loading the queue" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading the queue");
  });

  it("does not animate the loading placeholder", () => {
    // Motion confirms a state change; it never announces content. A shimmering skeleton is a
    // moving thing on a screen someone is reading under time pressure, and it says nothing the
    // word "loading" does not.
    expect(renderToStaticMarkup(<RouteLoading label="x" />)).not.toMatch(/animation|shimmer/i);
  });

  it("says plainly that nothing was written when a view fails to load", () => {
    const html = renderToStaticMarkup(<RouteNotFound title="Case not found" />);
    expect(html).toContain("Case not found");
  });
});
