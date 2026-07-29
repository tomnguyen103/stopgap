import Link from "next/link";
import { notFound } from "next/navigation";

import { COMPONENT_BUDGET, type ComponentName } from "@stopgap/scorer";

import { Badge, Card, Table } from "../../../components/ui";
import { getSignalDetail } from "../../../lib/data";
import { requireGroup } from "../../../lib/group-guard";
import { bandSeverity, componentLabel, partialScoreNotice } from "../../../lib/signal-list";

export const dynamic = "force-dynamic";

/**
 * One signal, its evidence and the breakdown behind its score (ticket 08).
 *
 * The evidence link points at the ORIGINATING source record, not at a copy of it held here: the
 * claim a viewer is asked to act on has to be checkable against the body that made it, and a
 * viewer who disagrees with this page can read what the body actually published.
 */
/**
 * The dedupe key as it was stored, from a segment that arrives percent-encoded.
 *
 * A dedupe key holds colons (`org:source:id`), so the link that reaches here is encoded and the
 * segment has to be decoded to match the row. `decodeURIComponent` THROWS on a lone `%`, though,
 * and a hand-typed `/signals/100%` would then be a 500 rather than a miss — so a malformed escape
 * degrades to the raw segment, which simply finds nothing.
 */
function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export default async function SignalDetailPage({ params }: { params: Promise<{ key: string }> }) {
  await requireGroup("viewer");
  const { key } = await params;
  const detail = await getSignalDetail(decodeKey(key));
  // A signal belonging to another tenant is not found rather than forbidden: a 403 would confirm
  // the key exists somewhere, which is a fact about another hospital's supply.
  if (!detail) notFound();
  const { signal, snapshot } = detail;
  const components = (snapshot?.components ?? null) as Record<string, number> | null;
  const notice = partialScoreNotice(components);

  return (
    <>
      <p className="sub">
        <Link href="/overview">← Overview</Link>
      </p>
      <h1>{signal.entityIdentifier}</h1>
      <p className="sub">
        {signal.riskDomain} · {signal.source.replace(/_/g, " ")} ·{" "}
        <Badge severity={bandSeverity(signal.severity)}>{signal.severity}</Badge>
      </p>

      <Card title={signal.title} sub="What the source says">
        <p>{signal.summary}</p>
        <Table label="Evidence" head={["Fact", "Value"]}>
          <tr>
            <td>Source record</td>
            <td>
              {/* rel=noreferrer: the originating body does not need to be told which console,
                  or which tenant's page, sent a reader to it. */}
              <a href={signal.evidenceUrl} target="_blank" rel="noreferrer noopener">
                {signal.evidenceUrl}
              </a>
            </td>
          </tr>
          <tr>
            <td>Published</td>
            <td>{signal.publishedAt.toISOString()}</td>
          </tr>
          <tr>
            <td>Observed</td>
            <td>{signal.observedAt.toISOString()}</td>
          </tr>
          <tr>
            <td>Last fetched</td>
            <td>{signal.lastFetchedAt.toISOString()}</td>
          </tr>
          <tr>
            <td>Freshness</td>
            <td>{signal.staleness}</td>
          </tr>
          <tr>
            <td>Source considers it resolved</td>
            <td>{signal.sourceResolved ? "yes" : "no"}</td>
          </tr>
          <tr>
            <td>Missed polls</td>
            <td>{signal.feedMissCount}</td>
          </tr>
        </Table>
      </Card>

      <Card
        title="Score"
        sub={snapshot ? `Scorer ${snapshot.scorerVersion}` : "Not scored by this poll"}
      >
        {snapshot === undefined ? (
          <p className="sub sub-tight">
            No snapshot yet. The scorer runs with the poll, so a signal ingested since the last run
            carries no score until the next one — shown as absent rather than as zero.
          </p>
        ) : (
          <>
            <p>
              <strong>{Number(snapshot.score).toFixed(1)}</strong>
              <span className="sub"> / {Number(snapshot.reachableMax).toFixed(0)}</span> ·{" "}
              <Badge severity={bandSeverity(snapshot.band)}>{snapshot.band}</Badge>
            </p>
            <Table label="Score components" head={["Component", "Points", "Budget"]}>
              {(Object.keys(COMPONENT_BUDGET) as ComponentName[]).map((name) => {
                const value = components?.[name];
                return (
                  <tr key={name}>
                    <td>{componentLabel(name)}</td>
                    <td>
                      {value === undefined ? (
                        <span className="sub">dark — needs catalog data</span>
                      ) : (
                        value.toFixed(1)
                      )}
                    </td>
                    <td className="sub">{COMPONENT_BUDGET[name]}</td>
                  </tr>
                );
              })}
            </Table>
            {notice ? (
              <p className="sub sub-tight" role="note">
                {notice}
              </p>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
