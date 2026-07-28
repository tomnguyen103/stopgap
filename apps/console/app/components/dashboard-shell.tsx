import Link from "next/link";
import type { ReactNode } from "react";
import { ActiveOrgBadge } from "../active-org-badge";

export interface NavLink {
  href: string;
  label: string;
}

/**
 * The chrome every dashboard group shares (ticket 03).
 *
 * One shell, four navs. The alternative — four hand-written headers — is four places to forget the
 * active-org badge, and forgetting it on the pharmacist surface is exactly where it matters most.
 *
 * Rendered by a GROUP layout, never by the root one. The root layout stays static so that a route
 * in any group is not re-rendered per session; session state is read here, one level down, where
 * the group guard already had to read it anyway.
 */
export function DashboardShell({
  surface,
  nav,
  children,
}: {
  /** Which dashboard this is, shown beside the brand so a role always knows where it is. */
  surface: string;
  nav: NavLink[];
  children: ReactNode;
}) {
  return (
    <>
      <header className="topbar">
        <span className="brand">◐ Stopgap</span>
        <span className="tag">{surface}</span>
        <nav className="nav">
          {nav.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
        {/*
          Rendered on EVERY group, not only the admin one. It appears at all only when an admin is
          acting inside a tenant that is not their own (PHASE6 §6.5) — and the surface where that
          matters most is the pharmacist queue, where clinical protocols get approved, not the
          admin screens where the switch was made. Scoping it to the admin group would remove the
          warning from precisely the place the mistake happens.
        */}
        <ActiveOrgBadge />
      </header>
      <main className="wrap">{children}</main>
    </>
  );
}
