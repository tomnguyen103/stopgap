import Link from "next/link";
import { Card } from "../../components/ui";
import { requireGroup } from "../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * The administration index.
 *
 * Calls `requireGroup` AGAIN, even though the group layout already did. Not redundancy for its own
 * sake: a layout guard covers every route in the group, and a page guard covers the page if it is
 * ever moved out of one — and the ticket's rule is that reaching a route grants nothing, which is
 * only true if each page still asks.
 */
export default async function AdminIndexPage() {
  await requireGroup("admin");
  return (
    <>
      <h1>Administration</h1>
      <p className="sub">Users, keys, tenants and the audit chain</p>
      <Card title="Setup" sub="What an administrator configures here">
        <ul className="sub sub-tight">
          <li>
            <Link href="/admin/users">Users and role grants</Link>
          </li>
          <li>
            <Link href="/admin/api-keys">API keys</Link>
          </li>
          <li>
            <Link href="/admin/organizations">Organizations and the active-org switch</Link>
          </li>
          <li>
            <Link href="/audit">Audit chain verification</Link>
          </li>
        </ul>
      </Card>
    </>
  );
}
