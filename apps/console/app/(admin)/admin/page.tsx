import Link from "next/link";
import { getEnv } from "@stopgap/core";
import { isDemoMode } from "@stopgap/demo";
import type { ConnectorRunOutcome } from "@stopgap/db";
import { SIGNAL_SOURCES } from "@stopgap/ingest";

import { Badge, Card, Table } from "../../components/ui";
import {
  getCatalogCoverage,
  getConnectorRuns,
  getFeedFreshness,
  getOversight,
} from "../../lib/data";
import { requireGroup } from "../../lib/group-guard";
import { SeedDemoPanel } from "./seed-demo-panel";

export const dynamic = "force-dynamic";

/** How stale a feed may be before an administrator should be looking at it. */
const FEED_QUIET_HOURS = 36;

/**
 * What a connector outcome is called on screen.
 *
 * Keyed to `ConnectorRunOutcome` rather than to `string`, so adding a value to the vocabulary
 * without adding a label here is a compile error. The lookup still falls back to the raw value,
 * because the column holds whatever the database holds: a row written by an older or newer
 * deployment renders as itself rather than as a blank cell.
 */
const OUTCOME_LABELS: Record<ConnectorRunOutcome, string> = {
  ok: "ok",
  fetch_failed: "fetch failed",
  persist_failed: "write failed",
};

/** The one timestamp format this page uses, in one place — minutes, UTC, no seconds. */
const stamp = (at: Date | string) => new Date(at).toISOString().slice(0, 16);

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
  const [coverage, feeds, oversight, connectorRuns] = await Promise.all([
    getCatalogCoverage(),
    getFeedFreshness(),
    getOversight(),
    getConnectorRuns(),
  ]);
  const env = getEnv();
  const now = Date.now();
  const isQuiet = (lastFetchedAt: Date | string) =>
    now - new Date(lastFetchedAt).getTime() > FEED_QUIET_HOURS * 3_600_000;

  // EVERY connector in the contract, not only the ones with a row. A connector that has never run
  // for this facility has nothing stored, and rendering only what is stored would drop it from the
  // table entirely — which reads identically to a connector that is fine. "Never run" is the exact
  // state a silent feed is in, so it has to have a line of its own.
  const bySource = new Map(connectorRuns.map((run) => [run.source, run]));
  const connectors = SIGNAL_SOURCES.map((source) => ({ source, run: bySource.get(source) }));

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
          : // The REASON belongs on both branches. It read only on the unset branch, so an
            // administrator on a configured deployment — the ordinary case — saw "deployment-wide"
            // and no explanation of why there is no control here to change it.
            `$${env.LLM_DAILY_USD_CAP.toFixed(2)} per day — $${oversight.spend.usd.toFixed(2)} spent today. Set by LLM_DAILY_USD_CAP in deployment environment, not here: the cap binds every process in the deployment, so a per-tenant control would let one hospital lift a limit that binds the others.`,
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
        CONNECTOR HEALTH, THIS FACILITY'S (ticket 17). The card below it reads `feed_records`, which
        is deployment-wide and written only by the shortage connectors; this one reads
        `connector_runs`, which is per tenant and covers every connector in the contract. The two
        answer different questions and both are worth having: "has this deployment heard from
        openFDA" is not "did my hospital get signals out of that poll".
      */}
      <Card
        title="Connector health"
        sub={`This facility's last run per feed · quiet for over ${String(FEED_QUIET_HOURS)} hours is flagged`}
      >
        <Table
          label="Connector health"
          head={["Connector", "Last run", "Signals", "Last success", "State"]}
        >
          {connectors.map(({ source, run }) => (
            <tr key={source}>
              <td>{source}</td>
              <td className="sub">{run ? stamp(run.ranAt) : "—"}</td>
              <td>{run ? run.signalCount : "—"}</td>
              <td className="sub">
                {/* Separate from the last RUN on purpose: a connector failing every poll for a week
                    still has a recent run, and the gap between the two columns is the whole signal. */}
                {run?.lastOkAt ? stamp(run.lastOkAt) : "never"}
              </td>
              <td>
                {!run ? (
                  <Badge severity="high">never run</Badge>
                ) : run.outcome !== "ok" ? (
                  <Badge severity="critical">
                    {OUTCOME_LABELS[run.outcome as ConnectorRunOutcome] ?? run.outcome}
                  </Badge>
                ) : isQuiet(run.ranAt) ? (
                  <Badge severity="critical">quiet</Badge>
                ) : (
                  <Badge tone="status">fresh</Badge>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {/* The failure itself, not just that there was one — an administrator who has to act needs
            to know whether the source is unreachable or this facility's own write is failing. */}
        {connectors
          .filter((c) => c.run?.detail)
          .map(({ source, run }) => (
            <p className="sub sub-tight" key={source}>
              <strong>{source}</strong>: {run?.detail}
            </p>
          ))}
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
        title="Feed records, deployment-wide"
        sub={`Provenance behind every case · quiet for over ${String(FEED_QUIET_HOURS)} hours is flagged`}
      >
        {feeds.length === 0 ? (
          <p className="sub sub-tight">
            No feed has stored a record in this deployment yet. Absence is the honest reading — it
            does not mean the feeds are healthy.
          </p>
        ) : (
          <Table label="Feed records" head={["Feed", "Last stored record", "Records", "State"]}>
            {feeds.map((feed) => (
              <tr key={feed.source}>
                <td>{feed.source}</td>
                <td className="sub">{stamp(feed.lastFetchedAt)}</td>
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
