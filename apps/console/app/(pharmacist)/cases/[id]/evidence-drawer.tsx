"use client";

import { useRef } from "react";

export interface EvidenceEntry {
  id: string;
  type: string;
  source: string;
  sourceId: string;
  originUrl: string;
  contentHash: string;
  capturedAt: string;
}

/**
 * The evidence behind a case, in a drawer rather than a page load (ticket 11).
 *
 * A NATIVE `<dialog>`, opened with `showModal()`. Focus trapping, Escape-to-close, inertness of the
 * page behind it and the top-layer stacking are all things the platform already does correctly, and
 * every one of them is a thing a hand-rolled div gets subtly wrong.
 *
 * The evidence is rendered by the SERVER and passed in as props, so the drawer opens with the trail
 * already present. Fetching on open would put a spinner between a pharmacist and the reason they
 * are being asked to approve something.
 */
export function EvidenceDrawer({
  entries,
  signalTitle,
}: {
  entries: EvidenceEntry[];
  signalTitle: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className="ds-button ds-button--quiet"
        type="button"
        onClick={() => dialog.current?.showModal()}
      >
        Evidence ({entries.length})
      </button>
      <dialog className="ds-drawer" ref={dialog} aria-label="Evidence behind this case">
        <div className="ds-drawer__head">
          <h2>Evidence</h2>
          <button
            className="ds-button ds-button--quiet"
            type="button"
            onClick={() => dialog.current?.close()}
          >
            Close
          </button>
        </div>
        {signalTitle ? <p className="sub">{signalTitle}</p> : null}
        {entries.length === 0 ? (
          <p className="sub sub-tight">
            No evidence captured for this case yet. The trail is written when a poll records the
            source record, so a case opened before this facility polled has none — which is a fact
            about the trail, not a claim that the hazard is unevidenced.
          </p>
        ) : (
          <ul className="ds-drawer__list">
            {entries.map((entry) => (
              <li key={entry.id}>
                <b>{entry.type}</b> · {entry.source}
                <div className="sub">
                  {/* The link is the point: a pharmacist checks the claim against the body that
                      made it, not against this page's copy of it. */}
                  <a href={entry.originUrl} target="_blank" rel="noreferrer noopener">
                    {entry.originUrl}
                  </a>
                </div>
                <div className="sub">
                  captured {new Date(entry.capturedAt).toLocaleString()} · sha256{" "}
                  <code>{entry.contentHash.slice(0, 12)}…</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </dialog>
    </>
  );
}
