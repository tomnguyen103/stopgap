import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The stylesheet's own integrity, asserted rather than assumed.
 *
 * A custom property that is referenced but never defined does not fail a build, does not fail a
 * lint and does not fail a render — the declaration reading it is simply dropped, and the element
 * silently falls back to whatever the initial value happens to be. `.ds-gates` read `--space-3`
 * for two tickets with nothing defining it, so its `gap` was invalid and collapsed to `0`; nobody
 * noticed because a list with no gap still looks like a list.
 *
 * The only reliable guard is a test that resolves every reference against every definition.
 */
const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** Every `--name:` that appears in a declaration position. */
function definedProperties(source: string): Set<string> {
  return new Set(Array.from(source.matchAll(/(--[a-z0-9-]+)\s*:/gi), (m) => m[1] ?? ""));
}

/**
 * Every `var(--name)` that has NO fallback. A reference with a fallback is deliberate — that is
 * how `--rail` and friends are meant to be optional — so only the bare ones are required to exist.
 */
function referencedWithoutFallback(source: string): Set<string> {
  return new Set(Array.from(source.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi), (m) => m[1] ?? ""));
}

describe("globals.css custom properties", () => {
  it("defines every custom property it reads without a fallback", () => {
    const defined = definedProperties(css);
    // `next/font` mints these on `<html>` at build time; nothing in the stylesheet can declare
    // them, and the whole point of the package is that the generated names are not hand-written.
    const fromNextFont = new Set(["--font-geist-sans", "--font-geist-mono"]);
    const dangling = [...referencedWithoutFallback(css)].filter(
      (name) => !defined.has(name) && !fromNextFont.has(name),
    );
    expect(dangling).toEqual([]);
  });
});
