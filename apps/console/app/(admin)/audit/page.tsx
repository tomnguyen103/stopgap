import { getAuditIntegrity } from "../../lib/data";
import { formatUtc } from "../../lib/format";
import { requireGroup } from "../../lib/group-guard";
import { Table } from "../../components/ui";

export const dynamic = "force-dynamic";

/**
 * Audit integrity (PHASE6 §6.2). Read-only verification surface: recomputes the hash-chained
 * audit log from genesis and cross-checks every external anchor against the live chain. A
 * broken chain names the exact first row that fails, so a tampered or truncated log is caught
 * and located rather than merely suspected. Works as a viewer in demo mode — it mutates
 * nothing.
 */
/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function AuditPage() {
  await requireGroup("admin");
  const { chain, anchors } = await getAuditIntegrity();

  return (
    <>
      <h1>Audit integrity</h1>
      <p className="sub">
        Hash-chained audit log verified from genesis, plus external anchors cross-checked against
        the live chain. HMAC (<code>AUDIT_HMAC_KEY</code>) and RFC 3161 timestamping (
        <code>AUDIT_TSA_URL</code>) are honest non-configuration when unset.
      </p>

      {chain.ok ? (
        <div className="banner ok">
          Chain verified — every row recomputes and links back to genesis.
        </div>
      ) : (
        <div className="banner bad">
          Chain BROKEN at row #{String(chain.brokenAtId)} ({chain.reason ?? "verification failed"}).
          Every row from that point on is unverifiable.
        </div>
      )}

      <h2>External anchors</h2>
      {anchors.length === 0 ? (
        <div className="empty">
          No anchors recorded yet. The hourly <code>anchor-audit</code> schedule writes one each
          hour once the worker and schedule are running.
        </div>
      ) : (
        <Table
          head={["Taken", "Head row", "Head hash", "Sink", "DB match", "External match"]}
          label="External audit anchors"
        >
          {anchors.map((a) => (
            <tr key={a.id}>
              <td className="is-subtle">{formatUtc(a.ts)}</td>
              <td>#{String(a.maxAuditId)}</td>
              <td className="mono" title={a.headHash}>
                {a.headHash.slice(0, 12)}…
              </td>
              <td>{a.sink}</td>
              <td className={a.headMatches ? "match-ok" : "match-bad"}>
                {a.headMatches ? "✓" : "✗ mismatch"}
              </td>
              <td
                className={
                  a.externalMatches === null ? "sub" : a.externalMatches ? "match-ok" : "match-bad"
                }
                title="Outside-the-DB anchor file vs the live chain"
              >
                {a.externalMatches === null ? "—" : a.externalMatches ? "✓" : "✗ mismatch"}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </>
  );
}
