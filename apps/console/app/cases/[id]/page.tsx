import Link from "next/link";
import { notFound } from "next/navigation";
import { getCaseDetail } from "../../lib/data";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCaseDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { case: c, audit } = detail;
  return (
    <>
      <p className="back">
        <Link href="/">← all cases</Link>
      </p>
      <h1>{c.genericName}</h1>
      <p className="sub">
        {c.status}
        {c.severity ? ` · severity ${c.severity}` : ""}
      </p>

      <div className="card">
        <dl className="kv">
          <dt>Workflow ID</dt>
          <dd>{c.workflowId}</dd>
          <dt>Dedup key</dt>
          <dd>{c.key}</dd>
          <dt>Source feed</dt>
          <dd>
            {c.source} ({c.sourceId})
          </dd>
          <dt>Affected NDCs</dt>
          <dd>{c.ndcs.length ? c.ndcs.join(", ") : "—"}</dd>
          <dt>Last note</dt>
          <dd>{c.lastNote ?? "—"}</dd>
          <dt>Opened</dt>
          <dd>{new Date(c.openedAt).toLocaleString()}</dd>
          {c.closedAt ? (
            <>
              <dt>Closed</dt>
              <dd>{new Date(c.closedAt).toLocaleString()}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="card">
        <h1 style={{ fontSize: 15 }}>Audit trail (hash-chained)</h1>
        <ol className="audit">
          {audit.map((a) => (
            <li key={a.id}>
              <b>{a.action}</b> · {a.actor} · {new Date(a.ts).toLocaleString()} ·{" "}
              <span title={a.hash}>{a.hash.slice(0, 10)}…</span>
            </li>
          ))}
        </ol>
      </div>
    </>
  );
}
