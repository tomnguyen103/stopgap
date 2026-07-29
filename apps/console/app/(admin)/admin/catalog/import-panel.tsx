"use client";

import { useState, useTransition } from "react";

import { importCatalogAction } from "../../../lib/actions";

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
            setErrors([]);
            setApplied(null);
            if (!file) {
              setCsv(null);
              setFileName(null);
              return;
            }
            setFileName(file.name);
            void file.text().then(setCsv);
          }}
        />
        <button
          type="button"
          className="ds-button"
          aria-disabled={blocked || undefined}
          title={unavailableReason ?? undefined}
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
