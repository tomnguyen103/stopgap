import Link from "next/link";
import { getEnv } from "@stopgap/core";
import { isDemoMode } from "@stopgap/demo";

import { Badge, Card, Table } from "../../components/ui";
import { getCatalogCoverage, getFeedFreshness, getOversight } from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { SeedDemoPanel } from "./seed-demo-panel";

export const dynamic = "force-dynamic";

/** How stale a feed may be before an administrator should be looking at it. */
const FEED_QUIET_HOURS = 36;

/**
 * The administrator's landing page: what still needs configuring, and whether the system is
 * healthy (ticket 17).
 *
 * A CHECKLIST OF FACTS, not of intentions. Each line is answered by a query rather than by a flag
 * somebody ticked, so an item cannot read as done while the thing it describes is missing.
 *
 * Calls `requireGroup` AGAIN, even though the group layout already did. Not redundancy for its own
 * sake: a layout guard covers every route in the group, and a page guard covers the page if it is
 * ever moved out of one — and the rule is that reaching a route grants nothing.
 */
export default async function AdminIndexPage() {
  const principal = await requireGroup("admin");
  const [coverage, feeds, oversight] = await Promise.all([
    getCatalogCoverage(),
    getFeedFreshness(),
    getOversight(),
  ]);
  const env = getEnv();
  const now = Date.now();
  const isQuiet = (lastFetchedAt: Date | string) =>
    now - new Date(lastFetchedAt).getTime() > FEED_QUIET_HOURS * 3_600_000;

  const checklist: {
    label: string;
    done: boolean;
    detail: string;
    /** Where to go and fix it. Absent when the fix is not in the console. */
    href?: string;
  }[] = [
    {
      label: "Catalog items loaded",
      done: coverage.items > 0,
      detail:
        coverage.items > 0
          ? `${String(coverage.items)} item${coverage.items === 1 ? "" : "s"}`
          : "Until a catalog is loaded, two of the three score components stay dark.",
      href: "/admin/catalog",
    },
    {
      label: "Suppliers linked to items",
      done: coverage.itemsWithSupplier > 0,
      detail:
        coverage.itemsWithSupplier > 0
          ? `${String(coverage.itemsWithSupplier)} of ${String(coverage.items)} items · ${String(coverage.soleSourced)} sole-sourced`
          : "Sole-source exposure cannot be computed without supplier links.",
      href: "/admin/catalog?sourcing=sole",
    },
    {
      label: "Inventory loaded",
      done: coverage.itemsWithInventory > 0,
      detail:
        coverage.itemsWithInventory > 0
          ? `${String(coverage.itemsWithInventory)} item${coverage.itemsWithInventory === 1 ? "" : "s"} with a reading`
          : "Days-on-hand stays dark until an inventory file is loaded.",
      href: "/admin/catalog",
    },
    {
      label: "A feed has returned data",
      done: feeds.length > 0,
      // `feed_records` is DEPLOYMENT-wide, not this tenant's: one openFDA snapshot is one physical
      // fact about the drug supply, stored once. It sits on the checklist because a facility whose
      // deployment has never polled is not set up — but it is labelled for what it is.
      detail:
        feeds.length > 0
          ? `${String(feeds.length)} feed${feeds.length === 1 ? "" : "s"} with stored records, deployment-wide`
          : "No poll has stored a record yet, anywhere in this deployment.",
    },
    {
      label: "Model spend cap configured",
      done: env.LLM_DAILY_USD_CAP !== undefined,
      // NOT a console setting. The cap governs every process in the deployment — a scheduled poll
      // spends the same dollars a visitor does — so a per-tenant toggle here would let one hospital
      // lift a limit that binds the others.
      detail:
        env.LLM_DAILY_USD_CAP === undefined
          ? "No cap set. LLM_DAILY_USD_CAP is deployment environment, not a console setting: the cap binds every process in the deployment, so a per-tenant control here would let one hospital lift a limit that binds the others."
          : `$${env.LLM_DAILY_USD_CAP.toFixed(2)} per day, deployment-wide — $${oversight.spend.usd.toFixed(2)} spent today.`,
      href: "/oversight",
    },
  ];

  return (
    <>
      <h1>Administration</h1>
      <p className="sub">
        {checklist.filter((row) => row.done).length} of {checklist.length} set up
        {isDemoMode() ? " · demo deployment" : ""}
      </p>

      <Card title="Setup checklist" sub="Each line answered by a query, not by a flag">
        <Table label="Setup checklist" head={["", "Item", "State"]}>
          {checklist.map((row) => (
            <tr key={row.label}>
              <td>
                {/* A word as well as a colour: a checklist that separates done from not-done by
                    green alone is unreadable to a reader who cannot see the difference. */}
                {row.done ? <Badge tone="status">done</Badge> : <Badge severity="high">to do</Badge>}
              </td>
              <td>
                {row.href === undefined ? row.label : <Link href={row.href}>{row.label}</Link>}
              </td>
              <td className="sub">{row.detail}</td>
            </tr>
          ))}
        </Table>
      </Card>

      {/*
        WHAT THIS CARD CAN SEE. `feed_records` is written by the shortage connectors; the recall
        connectors normalize straight onto the signal contract and store no feed record, so they
        cannot appear here yet. Naming that is the difference between "no recall feed is listed"
        and "the recall feed is fine".

        And `lastFetchedAt` moves on every poll that stores a record, including one that stored the
        same content again — so this answers "did the poll run", not "did the source change".
      */}
      <Card
        title="Feed health"
        sub={`A feed quiet for over ${String(FEED_QUIET_HOURS)} hours is flagged`}
      >
        {feeds.length === 0 ? (
          <p className="sub sub-tight">
            No feed has stored a record in this deployment yet. Absence is the honest reading — it
            does not mean the feeds are healthy.
          </p>
        ) : (
          <Table label="Feed health" head={["Feed", "Last stored record", "Records", "State"]}>
            {feeds.map((feed) => (
              <tr key={feed.source}>
                <td>{feed.source}</td>
                <td className="sub">{new Date(feed.lastFetchedAt).toISOString().slice(0, 16)}</td>
                <td>{feed.records}</td>
                <td>
                  {isQuiet(feed.lastFetchedAt) ? (
                    // A silent feed is the failure that hides every other one: no new signals looks
                    // exactly like no new hazards.
                    <Badge severity="critical">quiet</Badge>
                  ) : (
                    <Badge tone="status">fresh</Badge>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="sub sub-tight">
          Only the shortage connectors store feed records, so the recall connectors do not appear
          here. A last-stored time also moves on every poll that wrote a record — including one that
          rewrote unchanged content — so it reports that the poll ran, not that the source changed.
        </p>
      </Card>

      <Card
        title="Demo workspace"
        sub="Invented shortages for a walkthrough, never mixed with real ones"
      >
        <SeedDemoPanel roles={principal.roles} demoMode={isDemoMode()} />
      </Card>

      <Card title="Administration" sub="Catalog, users, keys, tenants and the audit chain">
        <ul className="sub sub-tight">
          <li>
            <Link href="/admin/catalog">Catalog — load, browse, and find sole-sourced items</Link>
          </li>
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
