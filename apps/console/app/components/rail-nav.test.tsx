import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * Which nav item is the current one.
 *
 * `/admin` and `/admin/users` are both real nav destinations in the admin group, and a plain "is
 * the path beneath this href" test marks BOTH on `/admin/users`. Two elements with
 * `aria-current="page"` is invalid, and a screen reader announces two current pages — on the
 * surface where an admin is deciding which tenant they are acting in.
 *
 * Rendered rather than reasoned about: `usePathname` is the whole input, so it is the one thing
 * worth faking.
 */
const NAV = [
  { href: "/admin", label: "Setup", icon: "setup" as const },
  { href: "/admin/catalog", label: "Catalog", icon: "catalog" as const },
  { href: "/admin/users", label: "Users", icon: "users" as const },
  { href: "/audit", label: "Audit", icon: "audit" as const },
];

async function currentFor(pathname: string): Promise<string[]> {
  vi.resetModules();
  vi.doMock("next/navigation", () => ({ usePathname: () => pathname }));
  // `next/link` needs a DOM router at import time; the element it renders is all this asserts.
  vi.doMock("next/link", () => ({
    default: ({ children, ...rest }: Record<string, unknown> & { children?: unknown }) =>
      createElement("a", rest, children as never),
  }));
  const { RailNav } = await import("./rail-nav");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const html = renderToStaticMarkup(<RailNav nav={NAV} />);
  return Array.from(
    html.matchAll(/<a[^>]*aria-current="page"[^>]*>.*?<span class="rail__label">([^<]*)</g),
    (m) => m[1] ?? "",
  );
}

describe("RailNav", () => {
  it("marks exactly one item on a nested route", async () => {
    expect(await currentFor("/admin/users")).toEqual(["Users"]);
  });

  it("marks the parent only when the path IS the parent", async () => {
    expect(await currentFor("/admin")).toEqual(["Setup"]);
  });

  it("marks the deepest match, not every ancestor", async () => {
    // `/admin/catalog/SKU-1` is beneath both `/admin` and `/admin/catalog`.
    expect(await currentFor("/admin/catalog/SKU-1")).toEqual(["Catalog"]);
  });

  it("marks nothing on a route the group does not list", async () => {
    expect(await currentFor("/access-denied")).toEqual([]);
  });

  it("does not treat a shared prefix as a parent", async () => {
    // `/auditing` is not beneath `/audit`, however similar the strings look.
    expect(await currentFor("/auditing")).toEqual([]);
  });
});
