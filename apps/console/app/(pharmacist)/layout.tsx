import type { ReactNode } from "react";
import { DashboardShell, type NavLink } from "../components/dashboard-shell";
import { requireGroup } from "../lib/group-guard";

/**
 * The clinical workspace: the case queue, the protocol history and the shadow ledger.
 *
 * A viewer reaching `/queue` is redirected to their own overview rather than shown an empty
 * page — the refusal is server-side and total, and reaching a route here still grants nothing.
 *
 * The guard runs HERE, in the layout, because it is the one place that covers every route in the
 * group — including ones added later, which is what stops a new page shipping unguarded.
 */

const NAV: NavLink[] = [
  { href: "/queue", label: "Queue" },
  { href: "/protocols", label: "Protocols" },
  { href: "/shadow", label: "Shadow" },
];

export default async function PharmacistLayout({ children }: { children: ReactNode }) {
  await requireGroup("pharmacist");
  return (
    <DashboardShell surface="pharmacist workspace" nav={NAV}>
      {children}
    </DashboardShell>
  );
}
