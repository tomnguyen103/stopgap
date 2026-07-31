"use client";

import { useState, useTransition } from "react";
import { issueApiKeyAction, revokeApiKeyAction } from "../../../lib/actions";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  CopyButton,
  Field,
  Table,
  Toggle,
} from "../../../components/ui";

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
      <Card title="Issue a key">
        <p className="sub-tight">
          Scopes are the whole authorization story for a key — it can do exactly what is ticked here
          and nothing else.
        </p>
        <div className="actions">
          <Field label="Name" hint="For example, epic-integration.">
            {(id, describedBy) => (
              <input
                id={id}
                aria-describedby={describedBy}
                className="reason-input"
                value={name}
                disabled={pending}
                onChange={(e) => {
                  setName(e.target.value);
                }}
              />
            )}
          </Field>
          <Field label="Requests per hour">
            {(id) => (
              <input
                id={id}
                className="reason-input"
                type="number"
                min={1}
                max={100000}
                value={rateLimit}
                disabled={pending}
                onChange={(e) => {
                  setRateLimit(Number(e.target.value));
                }}
              />
            )}
          </Field>
        </div>
        <div className="actions">
          {allScopes.map((scope) => (
            <Toggle
              key={scope}
              pressed={scopes.includes(scope)}
              disabled={pending}
              onClick={() => {
                toggleScope(scope);
              }}
            >
              {scope}
            </Toggle>
          ))}
        </div>
        <div className="actions">
          <Button
            type="button"
            disabled={pending || name.trim() === "" || scopes.length === 0}
            onClick={issue}
          >
            Issue key
          </Button>
        </div>
        {issued ? (
          /* CAUTION, not critical. `banner bad` is the treatment a BROKEN audit chain gets, and
             issuing a key successfully is not a failure — spending the critical red on it teaches
             an operator to read that colour as "notice", which is the one thing it must never mean. */
          <div className="banner warn">
            <p className="sub-tight">
              Copy the key for <b>{issued.name}</b> now — it is shown once and cannot be recovered.
              The server stores only its hash.
            </p>
            <p className="mono">{issued.plaintext}</p>
            <div className="actions">
              <CopyButton value={issued.plaintext} label="Copy key" />
              <Button
                type="button"
                onClick={() => {
                  setIssued(undefined);
                }}
              >
                I have copied it
              </Button>
            </div>
          </div>
        ) : null}
      </Card>

      {keys.length === 0 ? (
        <div className="empty">
          No keys issued — the public API refuses every request until one exists.
        </div>
      ) : (
        <Card>
          <Table
            head={["Name", "Prefix", "Scopes", "Limit/hr", "Last used", "State"]}
            label="Issued API keys"
          >
            {keys.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td className="mono">{key.keyPrefix}…</td>
                <td>
                  <div className="actions">
                    {key.scopes.map((scope) => (
                      <Badge key={scope}>{scope}</Badge>
                    ))}
                  </div>
                </td>
                <td>{key.rateLimitPerHour}</td>
                <td className="mono">{key.lastUsedAt ?? "never"}</td>
                <td>
                  {key.revokedAt ? (
                    <Badge severity="critical">revoked</Badge>
                  ) : (
                    <ConfirmButton
                      variant="danger"
                      disabled={pending}
                      target={`${key.name} (${key.keyPrefix}…)`}
                      confirmLabel="Revoke key"
                      description="Every request using this key starts failing immediately. Revoking cannot be undone — an integration that needs access again needs a new key."
                      action={() => {
                        run(() => revokeApiKeyAction(key.id));
                      }}
                    >
                      Revoke
                    </ConfirmButton>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
