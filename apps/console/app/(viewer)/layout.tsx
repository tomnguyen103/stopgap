import type { ReactNode } from "react";
import { DashboardShell, type NavLink } from "../components/dashboard-shell";
import { requireGroup } from "../lib/group-guard";

/**
 * The lowest-privilege surface, and the PUBLIC DEMO — one thing rather than two.
 *
 * `canViewGroup` puts every role at or above `viewer` here, so the anonymous visitor — who holds the
 * real `viewer` role, not an empty set — lands without a redirect loop: the guard sends a caller to
 * `roleLandingRoute(roles)`, which for `viewer` IS this group's route, so there is nothing left to
 * redirect to. A caller with NO recognized role is refused this group like any other and diverted to
 * `/access-denied`, which is outside every group and therefore terminates.
 *
 * The guard runs HERE, in the layout, because it is the one place that covers every route in the
 * group — including ones added later, which is what stops a new page shipping unguarded.
 */

const NAV: NavLink[] = [{ href: "/overview", label: "Overview" }];

export default async function ViewerLayout({ children }: { children: ReactNode }) {
  const principal = await requireGroup("viewer");
  return (
    <DashboardShell surface="viewer dashboard" nav={NAV} principal={principal.label}>
      {children}
    </DashboardShell>
  );
}
