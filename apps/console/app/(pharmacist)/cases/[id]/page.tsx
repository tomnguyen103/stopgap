import { createHash } from "node:crypto";

import Link from "next/link";
import { notFound } from "next/navigation";
import { isDemoMode } from "@stopgap/demo";
import { describeViolations, screenContent } from "@stopgap/compliance";
import { isActionAllowed } from "../../../lib/authz";
import { confidenceLabel, unavailableReason } from "../../../lib/case-queue";
import { getCaseDetail, getCaseEvidence, getWorkflowState } from "../../../lib/data";
import { EvidenceDrawer } from "./evidence-drawer";
import { resolvePrincipal } from "../../../lib/principal";
import { EscalationPanel } from "./escalation-panel";
import { ReviewPanel } from "./review-panel";
import { requireGroup } from "../../../lib/group-guard";

export const dynamic = "force-dynamic";

/**
 * Guards itself, and does not rely on the group layout having run.
 *
 * A layout is NOT an authorization boundary: Next does not re-render one on a soft navigation, and
 * the partial render is driven by router-state headers the client supplies. A crafted request can
 * render this page with the layout skipped entirely — so the check that matters is the one here.
 * The layout's guard stays, because it is what makes the redirect happen before any chrome paints.
 */
export default async function CaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireGroup("pharmacist");
  const { id } = await params;
  const detail = await getCaseDetail(decodeURIComponent(id));
  if (!detail) notFound();
  const { case: c, audit, acks } = detail;
  // The id the ROW carries, not one recomputed from the key (PHASE6 §6.5): a case opened before
  // workflow ids became org-qualified still answers only to `case-<key>`.
  const live = await getWorkflowState(c.workflowId);
  // The trail beside the draft, fetched with the page so the drawer opens on data rather than on
  // a spinner.
  const { signal, evidence } = await getCaseEvidence(c.genericName);
  // EVERY piece of generated text is screened before it renders, not only before it is sent.
  // A pharmacist reading a draft that names a patient has already been shown it, and a guard that
  // only runs at the outbound boundary is a guard the console walks around.
  const draftScreen = live?.draft ? screenContent(live.draft) : undefined;
  const alternativesScreen = live?.alternatives.length
    ? screenContent(live.alternatives.join("\n"))
    : undefined;
  const confidence = confidenceLabel(live?.researchConfidence);
  // ONE decision, read everywhere the draft could reach the page. Screening at the review panel
  // and rendering the same text again in the protocol card below would be a guard that announces
  // itself and then hands over the text anyway.
  const draftWithheld = draftScreen !== undefined && !draftScreen.ok;
  const alternativesWithheld = alternativesScreen !== undefined && !alternativesScreen.ok;
  // A FINGERPRINT for the React key, never the draft itself: a key is serialized into the Flight
  // payload the client receives, so keying on the text ships the withheld draft to the browser
  // that was not allowed to see it.
  const draftFingerprint = createHash("sha256")
    .update(live?.draft ?? "")
    .digest("hex")
    .slice(0, 16);
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

      {/* The evidence trail is a property of the CASE, not of the running workflow: a worker that
          is down must not take the reason for a decision off the page with it. */}
      <div className="card">
        <h2>Evidence</h2>
        <p className="sub sub-tight">
          {signal
            ? `Matched signal: ${signal.title}`
            : "No signal names this product yet, so there is no captured trail."}
        </p>
        <div className="actions">
          <EvidenceDrawer
            signalTitle={signal?.title ?? null}
            entries={evidence.map((entry) => ({
              id: entry.id,
              type: entry.type,
              source: entry.source,
              originUrl: entry.originUrl,
              contentHash: entry.contentHash,
              // ISO, formatted once on the server: see the note on `EvidenceEntry.capturedAt`.
              capturedAt: entry.capturedAt.toISOString().replace("T", " ").slice(0, 19) + "Z",
            }))}
          />
        </div>
      </div>

      {live && draftWithheld ? (
        // WITHHELD MEANS NO DECISION, not a decision on blank text. Rendering the panel with an
        // emptied draft leaves an Approve button that reads as "approve" while the pharmacist has
        // seen nothing — the same failure as approving text you cannot see, arrived at politely.
        <div className="card">
          <h2>Draft withheld</h2>
          <p className="sub">
            The compliance guard objected to this draft, so it is not rendered and no decision can
            be taken on it here. Categories: {describeViolations(draftScreen)}. The excerpt stays in
            the audit payload rather than on this page — a false positive is only fixable if
            somebody can see the line that tripped it, and a case page is a wider audience than
            that.
          </p>
        </div>
      ) : live ? (
        <ReviewPanel
          // Keyed on case + view + a FINGERPRINT of the draft: two cases sharing a draft (including
          // two empty ones in the exception view) would otherwise reuse one panel instance and
          // carry a half-typed rejection reason into the next case. The fingerprint rather than the
          // text, because a key travels to the client.
          key={`${c.workflowId}:${live.status}:${draftFingerprint}`}
          workflowId={c.workflowId}
          status={live.status}
          draft={live.draft ?? ""}
          alternatives={alternativesWithheld ? [] : live.alternatives}
          alternativesWithheld={alternativesWithheld}
          confidence={confidence}
          // Demo mode refuses every decision server-side. The controls RENDER, disabled, naming why
          // — a visitor should see the gate that exists rather than a page with no gate at all.
          unavailableReason={unavailableReason(
            isActionAllowed(principal.roles, "review_case"),
            "pharmacist",
            isDemoMode(),
          )}
        />
      ) : c.status === "awaiting_review" || c.status === "exception" ? (
        // Without live state there is no draft to read, and approving text you cannot see is
        // worse than waiting. Say why the gate is missing instead of rendering an empty one.
        <div className="card">
          <h2>Review unavailable</h2>
          <p className="sub">
            This case is {c.status.replace("_", " ")}, but the workflow could not be reached, so the
            drafted protocol cannot be shown. Start the worker (<code>pnpm worker</code>) and reload
            — decisions are taken against the live draft, never a stale copy.
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
          {/* Screened HERE too, not only at the review panel: this card renders the same text,
              and a guard that withholds a draft in one place and prints it in another guards
              nothing. */}
          {draftWithheld ? (
            <p className="sub sub-tight">
              Withheld by the compliance guard ({describeViolations(draftScreen)}).
            </p>
          ) : live.draft ? (
            <pre className="draft">{live.draft}</pre>
          ) : null}
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
        // Named rather than merely absent: a control above the caller's role renders disabled and
        // says which role it needs, so a viewer learns what to ask for instead of meeting a dead
        // page. The action still enforces this itself; the label is a courtesy, never the control.
        unavailableReason={unavailableReason(
          isActionAllowed(principal.roles, "review_case"),
          "pharmacist",
          isDemoMode(),
        )}
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
