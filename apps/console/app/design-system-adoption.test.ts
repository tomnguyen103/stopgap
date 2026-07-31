import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * One dialect, asserted.
 *
 * The console carried two parallel systems: `Card`/`Table`/`Badge`/`Button` in
 * `components/ui/`, and a set of hand-written `.card`/`.pill`/`.sev-*` rules plus bare element
 * selectors that most pages actually used. Two systems is two places to fix anything, and they
 * drifted — a bare `<table>` had no scroll container, so a five-column table pushed the whole PAGE
 * sideways on a phone instead of scrolling itself.
 *
 * These are the greps §9 names as the definition of done, run as tests so they cannot rot.
 */
const APP = fileURLToPath(new URL(".", import.meta.url));

function sources(): { path: string; text: string }[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(path);
      return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
    });
  return walk(APP).map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

/** Source with block comments removed — a rule that only appears in prose is not a usage. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The primitive is the one file allowed to write the element it wraps. */
const PRIMITIVES = new Set([
  "components/ui/table.tsx",
  "components/ui/button.tsx",
  "components/ui/toggle.tsx",
]);

function relative(path: string): string {
  return path.slice(APP.length).replaceAll("\\", "/");
}

function offenders(pattern: RegExp): string[] {
  return sources()
    .filter(({ path }) => !PRIMITIVES.has(relative(path)))
    .filter(({ text }) => pattern.test(code(text)))
    .map(({ path }) => relative(path))
    .sort();
}

describe("the design system is the only dialect", () => {
  it("has no bare <table>: every one goes through the Table primitive", () => {
    // The primitive brings a scroll container, `role="region"` and a label with it. Written by
    // hand, all three get forgotten, and the one that hurts is the container.
    expect(offenders(/<table[\s>]/)).toEqual([]);
  });

  it("has no bare <button>: every one goes through the Button primitive", () => {
    // Eight states, `:focus-visible` that is never transitioned, and `aria-busy` tied to the
    // loading state. A hand-written button gets whichever of those its author remembered.
    expect(offenders(/<button[\s>]/)).toEqual([]);
  });

  // `\\b` and not `\b`: inside a template literal a single backslash-b is the BACKSPACE character,
  // not a word boundary, and the pattern then matches nothing at all — a test that passes because
  // it asks nothing. Caught by checking the assertion still failed before the conversion landed.
  it.each(["card", "pill", "muted"])('has no className="%s" left', (name) => {
    expect(offenders(new RegExp(`className=(?:"|{\`)[^"\`]*\\b${name}\\b`))).toEqual([]);
  });

  it("has no inline style in any component", () => {
    // The last one was `style={{ fontSize: 15 }}` on the case page — a value the token layer
    // could not reach, on a heading that was also a second <h1>.
    expect(offenders(/style=\{\{/)).toEqual([]);
  });

  it("has no hex literal in any component", () => {
    // Colour lives in the token layer. A hex in a component is a colour no theme, no contrast
    // audit and no severity rule can see.
    expect(offenders(/["'`]#[0-9a-fA-F]{3,8}["'`]/)).toEqual([]);
  });
});

describe("the deleted legacy rules", () => {
  const css = readFileSync(join(APP, "globals.css"), "utf8");

  it.each([
    [".card", "the hand-written panel"],
    [".pill", "the hand-written badge"],
    [".sev-critical", "the parallel severity ramp"],
    ["button", "the bare element selector"],
    ["table", "the bare element selector"],
  ])("no longer defines a %s rule (%s)", (selector) => {
    // Anchored at a line start so `.card-title` and `.ds-button` do not read as matches.
    expect(css).not.toMatch(new RegExp(`^${selector.replace(".", "\\.")}\\s*\\{`, "m"));
  });
});
