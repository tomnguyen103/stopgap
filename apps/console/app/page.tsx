import Link from "next/link";
import { getCases } from "./lib/data";

export const dynamic = "force-dynamic";

function sevClass(sev: string | null): string {
  return sev ? `pill sev-${sev}` : "pill";
}

export default async function CasesPage() {
  const cases = await getCases();
  return (
    <>
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
