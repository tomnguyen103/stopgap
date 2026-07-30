"use client";

import { useState, useTransition } from "react";
import { issueApiKeyAction, revokeApiKeyAction } from "../../../lib/actions";

/**
 * API key management UI (PHASE6 §6.7). A thin client over the admin server actions, which re-check
 * `requireRole("manage_api_keys")` — this UI never carries authority on its own; hiding controls is
 * convenience, not the gate.
 *
 * The plaintext returned by `issueApiKeyAction` is held in component state only, shown once with an
 * explicit warning, and dismissed by the operator. It is never written anywhere persistent and
 * never logged: the server stores only its SHA-256 hash, so a key lost at this moment can only be
 * revoked and reissued. Saying so plainly on screen is the point — an operator who assumes they can
 * look it up later will discover otherwise at the worst time.
 */
interface AdminApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerHour: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const DEFAULT_RATE_LIMIT = 1000;

export function ApiKeysAdmin({ keys, allScopes }: { keys: AdminApiKey[]; allScopes: string[] }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [rateLimit, setRateLimit] = useState(DEFAULT_RATE_LIMIT);
  const [issued, setIssued] = useState<{ name: string; plaintext: string } | undefined>();

  function run(action: () => Promise<void>) {
    setError(undefined);
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  function toggleScope(scope: string) {
    setScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  }

  function issue() {
    run(async () => {
      const result = await issueApiKeyAction({ name, scopes, rateLimitPerHour: rateLimit });
      setIssued({ name: result.name, plaintext: result.plaintext });
      setName("");
      setScopes([]);
      setRateLimit(DEFAULT_RATE_LIMIT);
    });
  }

  return (
    <>
      <div className="card">
        <h2 className="card-title">Issue a key</h2>
        <p className="sub-tight">
          Scopes are the whole authorization story for a key — it can do exactly what is ticked here
          and nothing else.
        </p>
        <div className="actions">
          <input
            className="reason-input"
            placeholder="Name (e.g. epic-integration)"
            value={name}
            disabled={pending}
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
          <input
            className="reason-input"
            type="number"
            min={1}
            max={100000}
            value={rateLimit}
            disabled={pending}
            onChange={(e) => {
              setRateLimit(Number(e.target.value));
            }}
            aria-label="Requests per hour"
          />
        </div>
        <div className="actions">
          {allScopes.map((scope) => {
            const on = scopes.includes(scope);
            return (
              <button
                key={scope}
                type="button"
                className={on ? "pill" : "pill muted"}
                disabled={pending}
                onClick={() => {
                  toggleScope(scope);
                }}
              >
                {on ? `✓ ${scope}` : scope}
              </button>
            );
          })}
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={pending || name.trim() === "" || scopes.length === 0}
            onClick={issue}
          >
            Issue key
          </button>
        </div>
        {issued ? (
          <div className="banner bad">
            <p className="sub-tight">
              Copy the key for <b>{issued.name}</b> now — it is shown once and cannot be recovered.
              The server stores only its hash.
            </p>
            <p className="mono">{issued.plaintext}</p>
            <button
              type="button"
              onClick={() => {
                setIssued(undefined);
              }}
            >
              I have copied it
            </button>
          </div>
        ) : null}
      </div>

      {keys.length === 0 ? (
        <div className="empty">
          No keys issued — the public API refuses every request until one exists.
        </div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Limit/hr</th>
                <th>Last used</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono">{key.keyPrefix}…</td>
                  <td>
                    <div className="actions">
                      {key.scopes.map((scope) => (
                        <span key={scope} className="pill">
                          {scope}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{key.rateLimitPerHour}</td>
                  <td className="mono">{key.lastUsedAt ?? "never"}</td>
                  <td>
                    {key.revokedAt ? (
                      <span className="pill sev-critical">revoked</span>
                    ) : (
                      <button
                        type="button"
                        className="danger"
                        disabled={pending}
                        onClick={() => {
                          run(() => revokeApiKeyAction(key.id));
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
