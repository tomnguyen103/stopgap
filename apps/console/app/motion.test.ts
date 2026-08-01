import { describe, expect, it } from "vitest";
import { readGlobalsCss } from "./design-test-helpers";

/**
 * The motion rules (§7), asserted.
 *
 * Motion is the part of a design system that rots first, because a violation costs nothing at
 * build time: a `transition: all` ships, a `top` animation ships, a reduced-motion block that
 * covers one selector ships. None of them fails anything until someone with a vestibular disorder
 * opens the queue.
 */
const css = readGlobalsCss();

describe("motion", () => {
  it("uses the house curve", () => {
    expect(css).toMatch(/--ease-out:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\);/);
    expect(css).toMatch(/--ease-in:\s*cubic-bezier\(0\.4, 0, 1, 1\);/);
  });

  it.each([
    ["--dur-fast", "120ms"],
    ["--dur-base", "180ms"],
    ["--dur-slow", "240ms"],
  ])("defines %s as %s", (token, value) => {
    expect(css).toMatch(new RegExp(`${token}:\\s*${value};`));
  });

  it("never transitions every property", () => {
    // `transition: all` animates whatever a future rule happens to add, including layout.
    expect(css).not.toMatch(/transition:\s*all\b/);
  });

  it("animates only transform and opacity, never layout", () => {
    const animated = Array.from(css.matchAll(/transition:\s*([^;]+);/g), (m) => m[1] ?? "").join(
      " ",
    );
    for (const property of ["width", "height", "top ", "left ", "margin", "padding"]) {
      expect(animated).not.toContain(property);
    }
  });

  it("never transitions a focus ring into existence", () => {
    // A ring that fades in is a ring a keyboard user can miss.
    const rings = Array.from(css.matchAll(/:focus-visible\s*\{([^}]*)\}/g), (m) => m[1] ?? "");
    expect(rings.filter((block) => block.includes("transition"))).toEqual([]);
  });

  it("drops every duration under prefers-reduced-motion, not just the button's", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
    expect(block).toContain("animation-duration: 1ms !important");
    expect(block).toContain("transition-duration: 1ms !important");
  });

  it("keeps a non-zero reduced-motion duration so transitionend still fires", () => {
    // `0s` would silently break anything waiting on the event; `1ms` is imperceptible and real.
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).not.toMatch(/duration:\s*0s/);
  });

  it("builds the pending indicator without a layout shift", () => {
    // A spinner glyph replacing a label changes the button's width mid-action. A bar inside the
    // existing box does not, which is why it is a pseudo-element on an `overflow: hidden` button.
    const loading = /\.ds-button\[data-state="loading"\] \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(loading).toContain("overflow: hidden");
    expect(css).toMatch(/@keyframes ds-indeterminate \{[\s\S]*?transform: translateX/);
  });

  it("opens the drawer with transform and opacity only", () => {
    const frames = /@keyframes ds-drawer-in \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(frames).toContain("opacity");
    expect(frames).toContain("transform: scale");
    expect(frames).not.toMatch(/width|height|top|left/);
  });
});
