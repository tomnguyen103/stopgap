import type { ReactNode } from "react";
import { ActiveOrgBadge } from "../active-org-badge";
import type { NavLink } from "./nav-link";
import { RailNav } from "./rail-nav";

export type { NavLink };

/**
 * The chrome every dashboard group shares (ticket 03, rebuilt in P2.1).
 *
 * One shell, four navs. The alternative — four hand-written headers — is four places to forget the
 * active-org badge, and forgetting it on the pharmacist surface is exactly where it matters most.
 *
 * A PERSISTENT LEFT RAIL at >=1024px, an icon-width rail at 768–1023, and a WRAPPING top bar below
 * that. The single top bar it replaces was a non-wrapping flex row: the admin group put six nav
 * links plus the brand, the surface tag and a `white-space: nowrap` org badge into it — roughly
 * 600px of content in a 375px viewport — so the whole page scrolled sideways on a phone. Six items
 * stacked vertically do not compete for width, which is why the rail is the fix rather than a
 * smaller font.
 *
 * The principal and the org badge pin to the bottom of the rail. In the top bar the badge floated
 * in a flex row and moved every time the nav changed length; in the rail it has a permanent place,
 * which is what a state indicator needs to be read as one.
 *
 * Rendered by a GROUP layout, never by the root one. The root layout stays static so that a route
 * in any group is not re-rendered per session; session state is read here, one level down, where
 * the group guard already had to read it anyway.
 */
export function DashboardShell({
  surface,
  nav,
  principal,
  children,
}: {
  /** Which dashboard this is, shown beside the brand so a role always knows where it is. */
  surface: string;
  nav: NavLink[];
  /** Who is signed in, as the audit chain would name them. */
  principal: string;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="rail">
        <div className="rail__head">
          <span className="rail__brand">◐ Stopgap</span>
          <span className="rail__surface">{surface}</span>
        </div>
        <RailNav nav={nav} />
        <div className="rail__foot">
          {/*
            Rendered on EVERY group, not only the admin one. It appears at all only when an admin
            is acting inside a tenant that is not their own (PHASE6 §6.5) — and the surface where
            that matters most is the pharmacist queue, where clinical protocols get approved, not
            the admin screens where the switch was made. Scoping it to the admin group would remove
            the warning from precisely the place the mistake happens.
          */}
          <ActiveOrgBadge />
          <p className="rail__principal">{principal}</p>
        </div>
      </header>
      <main className="shell__main">{children}</main>
    </div>
  );
}
