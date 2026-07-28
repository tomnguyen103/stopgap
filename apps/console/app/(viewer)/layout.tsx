import type { ReactNode } from "react";
import { DashboardShell, type NavLink } from "../components/dashboard-shell";
import { requireGroup } from "../lib/group-guard";

/**
 * The lowest-privilege surface, and the PUBLIC DEMO — one thing rather than two.
 *
 * `canViewGroup` puts every role at or above `viewer` here, so an anonymous visitor with no
 * roles at all resolves to `viewer` and lands without a redirect loop: the guard sends a caller
 * to `roleLandingRoute(roles)`, which for no roles IS this group's route, so there is nothing
 * left to redirect to.
 *
 * The guard runs HERE, in the layout, because it is the one place that covers every route in the
 * group — including ones added later, which is what stops a new page shipping unguarded.
 */

const NAV: NavLink[] = [{ href: "/overview", label: "Overview" }];

export default async function ViewerLayout({ children }: { children: ReactNode }) {
  await requireGroup("viewer");
  return (
    <DashboardShell surface="viewer dashboard" nav={NAV}>
      {children}
    </DashboardShell>
  );
}
