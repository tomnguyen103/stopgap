"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./icon-sprite";
import type { NavLink } from "./nav-link";

/**
 * The rail's navigation, and the only client component in the shell.
 *
 * It is a client component for exactly one reason: `aria-current="page"` needs the current path,
 * and the alternative — threading a pathname down from every group layout — would make four
 * layouts responsible for a fact the router already knows. Nothing else here is interactive.
 *
 * A nav item is "current" when its href is the LONGEST one the path matches. That last word is
 * the whole rule: the admin group has both `/admin` and `/admin/users`, and a plain "is the path
 * beneath this href" test marks BOTH on `/admin/users` — two items with `aria-current="page"`,
 * which is invalid and reads to a screen reader as two current pages. Longest match picks Users
 * and leaves Setup alone.
 */
export function RailNav({ nav }: { nav: NavLink[] }) {
  const pathname = usePathname();
  const currentHref = nav
    .filter((link) => pathname === link.href || pathname.startsWith(`${link.href}/`))
    .reduce<string | null>(
      (best, link) => (best === null || link.href.length > best.length ? link.href : best),
      null,
    );
  return (
    <nav className="rail__nav" aria-label="Primary">
      <ul className="rail__list">
        {nav.map((link) => {
          const current = link.href === currentHref;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className="rail__item"
                aria-current={current ? "page" : undefined}
              >
                <Icon name={link.icon} />
                {/* Visually hidden at the icon-only breakpoint, never REMOVED: the accessible
                    name of a nav item must not depend on a picture. */}
                <span className="rail__label">{link.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
