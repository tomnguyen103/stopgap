import Link from "next/link";
import { notFound } from "next/navigation";
import { isDemoMode } from "@stopgap/demo";
import { isActionAllowed } from "../../../lib/authz";
import { getCaseDetail, getWorkflowState } from "../../../lib/data";
import { resolvePrincipal } from "../../../lib/principal";
import { EscalationPanel } from "./escalation-panel";
import { ReviewPanel } from "./review-panel";

export const dynamic = "force-dynamic";

export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCaseDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { case: c, audit, acks } = detail;
  // The id the ROW carries, not one recomputed from the key (PHASE6 §6.5): a case opened before
  // workflow ids became org-qualified still answers only to `case-<key>`.
  const live = await getWorkflowState(c.workflowId);
  // Server component, so the caller's roles are available here. `isActionAllowed` is the pure,
  // non-throwing half of the same matrix `requireRole` enforces in the action.
  const principal = await resolvePrincipal();
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

      <EscalationPanel
        workflowId={c.workflowId}
        escalationStep={live?.escalationStep}
        escalationEvents={live?.escalationEvents ?? []}
        acked={live?.acked ?? acks.length > 0}
        ackError={live?.ackError}
        acks={acks.map((a) => ({
          step: a.step,
          ackAt: a.ackAt.toISOString(),
          ackedByLabel: a.ackedByLabel,
        }))}
        // Same stance as the review gate above: a button that always fails is a worse lie than
        // its absence. Demo mode refuses every ack, and a signed-in viewer without `review_case`
        // would fail server-side — so neither is offered the button. The action still enforces
        // this itself; hiding it is a courtesy, never the control.
        canAck={!isDemoMode() && isActionAllowed(principal.roles, "review_case")}
      />

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
