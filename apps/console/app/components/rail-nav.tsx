"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavLink } from "./nav-link";

/**
 * The rail's navigation, and the only client component in the shell.
 *
 * It is a client component for exactly one reason: `aria-current="page"` needs the current path,
 * and the alternative — threading a pathname down from every group layout — would make four
 * layouts responsible for a fact the router already knows. Nothing else here is interactive.
 *
 * A nav item is "current" when the path IS the item's href or sits beneath it, so `/admin/users`
 * marks Users rather than Setup. `/admin` itself is matched exactly, otherwise it would light up
 * on every admin route.
 */
export function RailNav({ nav }: { nav: NavLink[] }) {
  const pathname = usePathname();
  return (
    <nav className="rail__nav" aria-label="Primary">
      <ul className="rail__list">
        {nav.map((link) => {
          const current = pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className="rail__item"
                aria-current={current ? "page" : undefined}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
