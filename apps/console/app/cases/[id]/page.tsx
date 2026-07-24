import Link from "next/link";
import { notFound } from "next/navigation";
import { isDemoMode } from "@stopgap/demo";
import { getCaseDetail, getWorkflowState } from "../../lib/data";
import { ReviewPanel } from "./review-panel";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCaseDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { case: c, audit } = detail;
  const live = await getWorkflowState(c.key);
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

      {live && isDemoMode() ? (
        // The server action refuses these decisions in demo mode regardless; showing buttons
        // that always fail would be a worse lie than saying so up front. The draft below is
        // still the live one, so a visitor sees exactly what a pharmacist would decide on.
        <div className="card">
          <h2>Pharmacist review (disabled in demo)</h2>
          <p className="sub">
            This case is blocked on a pharmacist decision. Approving clinical guidance needs a
            verified reviewer, and this deployment has no auth layer — so the demo shows the
            gate without opening it.
          </p>
        </div>
      ) : live ? (
        <ReviewPanel
          // Keyed on case + view + draft: two cases sharing a draft (including two empty ones
          // in the exception view) would otherwise reuse one panel instance and carry a
          // half-typed rejection reason or resolution into the next case.
          key={`${c.workflowId}:${live.status}:${live.draft ?? ""}`}
          workflowId={c.workflowId}
          status={live.status}
          draft={live.draft ?? ""}
          alternatives={live.alternatives}
        />
      ) : c.status === "awaiting_review" || c.status === "exception" ? (
        // Without live state there is no draft to read, and approving text you cannot see is
        // worse than waiting. Say why the gate is missing instead of rendering an empty one.
        <div className="card">
          <h2>Review unavailable</h2>
          <p className="sub">
            This case is {c.status.replace("_", " ")}, but the workflow could not be reached, so
            the drafted protocol cannot be shown. Start the worker (<code>pnpm worker</code>)
            and reload — decisions are taken against the live draft, never a stale copy.
          </p>
        </div>
      ) : null}

      {live?.protocolSource ? (
        <div className="card">
          <h2>Protocol</h2>
          <p className="sub">
            {live.protocolSource === "memory"
              ? `Reused approved protocol v${String(live.protocolVersion)} from organizational memory`
              : live.protocolSource === "exception-resolution"
                ? "Written by a pharmacist resolving the exception"
                : "Drafted by the alternatives agent"}
          </p>
          {live.draft ? <pre className="draft">{live.draft}</pre> : null}
        </div>
      ) : null}

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
