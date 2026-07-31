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
const PRIMITIVES = new Set(["components/ui/table.tsx"]);

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
});
