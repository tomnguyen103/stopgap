"use client";

import { useState, useTransition } from "react";
import { startDemoShortage } from "./lib/actions";

/**
 * "Run a shortage" (PROJECT_PLAN §11). Each button starts a real durable case through the
 * real agents — the visitor watches the same machine a pharmacist would, they just can't
 * approve anything. The catalogue comes from the server so the client can never name a drug
 * the server hasn't allow-listed.
 */
export function DemoPanel({ drugs }: { drugs: { key: string; genericName: string }[] }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  function run(key: string) {
    setMessage(undefined);
    setError(undefined);
    startTransition(async () => {
      try {
        const result = await startDemoShortage(key);
        if (result.ok) {
          setMessage(
            result.started
              ? `Started ${result.workflowId}. The case appears below as the workflow advances.`
              : `A case for that drug is already running (${result.workflowId}).`,
          );
        } else {
          setError(result.message);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="card">
      <h2 className="card-title">Run a shortage</h2>
      <p className="sub sub-tight">
        Starts a real Temporal case against the live agent layer. Reviews stay disabled — this
        is a read-only demo.
      </p>
      <div className="actions">
        {drugs.map((d) => (
          <button key={d.key} onClick={() => run(d.key)} disabled={pending}>
            {d.genericName}
          </button>
        ))}
      </div>
      {message ? <p className="sub sub-note">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
