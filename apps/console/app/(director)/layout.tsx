import type { ReactNode } from "react";
import { DashboardShell, type NavLink } from "../components/dashboard-shell";
import { requireGroup } from "../lib/group-guard";

/**
 * Oversight: the same cases a pharmacist works, read for trend rather than for action, plus the
 * deployment's KPIs.
 *
 * The guard runs HERE, in the layout, because it is the one place that covers every route in the
 * group — including ones added later, which is what stops a new page shipping unguarded.
 */

const NAV: NavLink[] = [
  { href: "/oversight", label: "Oversight", icon: "oversight" },
  { href: "/approvals", label: "Approvals", icon: "approvals" },
  { href: "/alerts", label: "Alerts", icon: "alerts" },
  { href: "/brief", label: "Daily brief", icon: "brief" },
  { href: "/metrics", label: "KPIs", icon: "metrics" },
];

export default async function DirectorLayout({ children }: { children: ReactNode }) {
  const principal = await requireGroup("pharmacy_director");
  return (
    <DashboardShell surface="director oversight" nav={NAV} principal={principal.label}>
      {children}
    </DashboardShell>
  );
}
