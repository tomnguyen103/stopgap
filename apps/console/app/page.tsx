import Link from "next/link";
import { DEMO_DRUGS, isDemoMode } from "@stopgap/demo";
import { DemoPanel } from "./demo-panel";
import { getCases, getFeedFreshness } from "./lib/data";

export const dynamic = "force-dynamic";

function sevClass(sev: string | null): string {
  return sev ? `pill sev-${sev}` : "pill";
}

export default async function CasesPage() {
  const [cases, feeds] = await Promise.all([getCases(), getFeedFreshness()]);
  return (
    <>
      {isDemoMode() ? (
        <DemoPanel drugs={DEMO_DRUGS.map((d) => ({ key: d.key, genericName: d.genericName }))} />
      ) : null}
      <div className="card">
        <h2 className="card-title">Feeds</h2>
        {feeds.length === 0 ? (
          // Absence is the honest reading: no stored record means no feed has returned data
          // to this deployment yet (ASHP without a key never does).
          <p className="sub sub-tight">No feed data yet — run the poll schedule.</p>
        ) : (
          <p className="sub sub-tight">
            {feeds.map((f) => (
              <span key={f.source} className="feed-line">
                <b>{f.source}</b> · last polled {new Date(f.lastFetchedAt).toLocaleString()} ·{" "}
                {f.records} record{f.records === 1 ? "" : "s"}
              </span>
            ))}
          </p>
        )}
      </div>
      <h1>Shortage cases</h1>
      <p className="sub">
        {cases.length} case{cases.length === 1 ? "" : "s"} · durable Temporal workflows mirrored from Postgres
      </p>
      {cases.length === 0 ? (
        <div className="empty">
          No cases yet. Open one:{" "}
          <code>pnpm --filter @stopgap/workflows start-case &quot;heparin&quot;</code>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Drug</th>
              <th>Status</th>
              <th>Severity</th>
              <th>Source</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {cases.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/cases/${encodeURIComponent(c.workflowId)}`}>{c.genericName}</Link>
                </td>
                <td className="status">{c.status}</td>
                <td>{c.severity ? <span className={sevClass(c.severity)}>{c.severity}</span> : "—"}</td>
                <td>{c.source}</td>
                <td>{new Date(c.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
