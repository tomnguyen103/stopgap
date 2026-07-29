import type { ReactNode } from "react";
import { DashboardShell, type NavLink } from "../components/dashboard-shell";
import { requireGroup } from "../lib/group-guard";

/**
 * Administration: users, API keys, organizations and the audit chain.
 *
 * The audit view lives here rather than on the director surface because reading the chain is a
 * deployment-integrity question, not a clinical one.
 *
 * The guard runs HERE, in the layout, because it is the one place that covers every route in the
 * group — including ones added later, which is what stops a new page shipping unguarded.
 */

const NAV: NavLink[] = [
  { href: "/admin", label: "Setup" },
  { href: "/admin/catalog", label: "Catalog" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/api-keys", label: "API keys" },
  { href: "/admin/organizations", label: "Organizations" },
  { href: "/audit", label: "Audit" },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireGroup("admin");
  return (
    <DashboardShell surface="administration" nav={NAV}>
      {children}
    </DashboardShell>
  );
}
