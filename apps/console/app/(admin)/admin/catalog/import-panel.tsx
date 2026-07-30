"use client";

import { useRef, useState, useTransition } from "react";

import { importCatalogAction } from "../../../lib/actions";
import { MAX_UPLOAD_BYTES } from "../../../lib/catalog-list";

/**
 * Upload a catalog file, and read back what was wrong with it (ticket 17).
 *
 * The file is read in the BROWSER and posted as text, so the server action takes a string rather
 * than a multipart body — one code path, and the same one the CLI importer uses.
 *
 * Failures are listed in full, per row, with their line numbers. An importer that stops at the
 * first bad line turns a 4,000-row export into forty round trips.
 */


export function ImportPanel({
  kinds,
  unavailableReason,
}: {
  kinds: readonly string[];
  unavailableReason: string | null;
}) {
  const blocked = Boolean(unavailableReason);
  const [pending, startTransition] = useTransition();
  const [kind, setKind] = useState(kinds[0] ?? "items");
  const [fileName, setFileName] = useState<string | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [applied, setApplied] = useState<string | null>(null);
  // Which selection the pending read belongs to. Two files chosen quickly can resolve out of
  // order, and without this the panel can hold file A's text under file B's name.
  const selection = useRef(0);

  return (
    <>
      {unavailableReason ? (
        <p className="sub sub-tight" role="note">
          {unavailableReason}
        </p>
      ) : null}
      <div className="ds-filters">
        <label className="sub" htmlFor="catalog-kind">
          File contains
        </label>
        <select
          className="ds-input"
          id="catalog-kind"
          value={kind}
          disabled={pending}
          onChange={(event) => {
            setKind(event.target.value);
          }}
        >
          {kinds.map((value) => (
            <option key={value} value={value}>
              {value.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <input
          className="ds-input"
          type="file"
          accept=".csv,text/csv"
          aria-label="Catalog CSV file"
          disabled={pending}
          onChange={(event) => {
            const file = event.target.files?.[0];
            const token = ++selection.current;
            setErrors([]);
            setApplied(null);
            setCsv(null);
            if (!file) {
              setFileName(null);
              return;
            }
            // A browser tab holds the whole file in memory before anything is sent, so the bound
            // is enforced HERE as well as at the server action — an unreadable 400MB export
            // should say so rather than freeze the page.
            if (file.size > MAX_UPLOAD_BYTES) {
              setFileName(file.name);
              setErrors([
                `That file is ${(file.size / 1_000_000).toFixed(1)} MB. The import accepts up to ` +
                  `${String(MAX_UPLOAD_BYTES / 1_000_000)} MB — split the export and load it in parts.`,
              ]);
              return;
            }
            setFileName(file.name);
            file.text().then(
              (text) => {
                if (selection.current === token) setCsv(text);
              },
              (error: unknown) => {
                if (selection.current !== token) return;
                setErrors([
                  `The file could not be read: ${error instanceof Error ? error.message : String(error)}`,
                ]);
              },
            );
          }}
        />
        <button
          type="button"
          className="ds-button"
          aria-disabled={blocked || undefined}
          // The reason belongs in the ACCESSIBLE NAME as well as the tooltip, the way
          // `components/role-gated.tsx` composes them: browsers do not fire `title` for a screen
          // reader, so a tooltip-only explanation reaches everyone except the people who most need
          // it. Composed with the control's own name rather than replacing it — a bare reason
          // announces why without saying which control it belongs to.
          title={unavailableReason ?? undefined}
          aria-label={unavailableReason ? `Import — ${unavailableReason}` : undefined}
          disabled={pending || csv === null}
          onClick={() => {
            if (blocked || csv === null) return;
            setErrors([]);
            setApplied(null);
            startTransition(async () => {
              try {
                const result = await importCatalogAction(kind, csv);
                if (result.ok) {
                  setApplied(`${String(result.rowsApplied)} ${result.kind} rows applied`);
                  // The file is spent. Leaving it loaded invites a second click that re-applies
                  // it, which for inventory and procurement is not the same as applying it once.
                  setCsv(null);
                  setFileName(null);
                } else {
                  setErrors(result.errors);
                }
              } catch (err) {
                setErrors([err instanceof Error ? err.message : String(err)]);
              }
            });
          }}
        >
          {pending ? "Importing…" : "Import"}
        </button>
        {fileName ? <span className="sub">{fileName}</span> : null}
      </div>

      {applied ? (
        <p className="sub sub-tight" role="status">
          {applied}.
        </p>
      ) : null}

      {errors.length > 0 ? (
        <>
          <p className="sub sub-tight" role="alert">
            Nothing was written. {errors.length} row
            {errors.length === 1 ? "" : "s"} could not be read — the import is refused as a whole,
            because a half-applied catalog is a facility that believes it stocks things it does not.
          </p>
          <ul className="ds-errors">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
