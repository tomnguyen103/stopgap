"use client";

import { useState, useTransition } from "react";

import { createAlertRuleAction, updateAlertRuleAction } from "../../lib/actions";

export interface RuleView {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: string;
  cooldownMinutes: number;
  channels: string[];
  riskDomain: string | null;
  entityContains: string | null;
  /** When this rule last fired, already formatted by the server. */
  lastFired: string | null;
}

/**
 * Create and tune alert rules (ticket 14).
 *
 * A rule decides who is paged, how often, and about what — which is why every control here renders
 * even when the caller cannot use it, disabled and naming the role. A director who cannot see the
 * rules cannot ask for the one that is wrong to be changed.
 *
 * The cooldown is bounded at 1 minute in this form AND refused below that by the database helper.
 * Two checks on purpose: this one turns a form post into a typed value, and that one is the rule
 * for every caller, including the API.
 */
export function RulesPanel({
  rules,
  unavailableReason,
}: {
  rules: RuleView[];
  unavailableReason: string | null;
}) {
  const blocked = Boolean(unavailableReason);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [minSeverity, setMinSeverity] = useState("high");
  const [cooldown, setCooldown] = useState("60");
  const [channels, setChannels] = useState<string[]>(["email"]);

  function run(action: () => Promise<void>) {
    if (blocked) return;
    setError(undefined);
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <>
      {unavailableReason ? (
        <p className="sub sub-tight" role="note">
          {unavailableReason}
        </p>
      ) : null}

      <table className="ds-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Fires at</th>
            <th>Cooldown</th>
            <th>Channels</th>
            <th>Last fired</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {rules.length === 0 ? (
            <tr>
              <td colSpan={6} className="sub">
                No rules yet. Nothing is being alerted on.
              </td>
            </tr>
          ) : (
            rules.map((rule) => (
              <tr key={rule.id}>
                <td>
                  {rule.name}
                  {rule.riskDomain ? <span className="sub"> · {rule.riskDomain}</span> : null}
                  {rule.entityContains ? (
                    <span className="sub"> · names containing “{rule.entityContains}”</span>
                  ) : null}
                </td>
                <td>{rule.minSeverity} and above</td>
                <td>
                  <label className="sub" htmlFor={`cooldown-${rule.id}`}>
                    minutes
                  </label>{" "}
                  <input
                    className="ds-input ds-input--inline"
                    id={`cooldown-${rule.id}`}
                    type="number"
                    min={1}
                    defaultValue={rule.cooldownMinutes}
                    disabled={pending}
                    aria-disabled={blocked || undefined}
                    title={unavailableReason ?? undefined}
                    onBlur={(event) => {
                      const next = Number(event.target.value);
                      if (next === rule.cooldownMinutes) return;
                      run(() =>
                        updateAlertRuleAction(rule.id, {
                          name: rule.name,
                          minSeverity: rule.minSeverity,
                          cooldownMinutes: next,
                          channels: rule.channels,
                          riskDomain: rule.riskDomain,
                          entityContains: rule.entityContains,
                          enabled: rule.enabled,
                        }),
                      );
                    }}
                  />
                </td>
                <td>{rule.channels.join(", ")}</td>
                <td className="sub">{rule.lastFired ?? "never"}</td>
                <td>
                  <button
                    type="button"
                    className="ds-button ds-button--quiet"
                    aria-disabled={blocked || undefined}
                    title={unavailableReason ?? undefined}
                    disabled={pending}
                    onClick={() => {
                      run(() =>
                        updateAlertRuleAction(rule.id, {
                          name: rule.name,
                          minSeverity: rule.minSeverity,
                          cooldownMinutes: rule.cooldownMinutes,
                          channels: rule.channels,
                          riskDomain: rule.riskDomain,
                          entityContains: rule.entityContains,
                          enabled: !rule.enabled,
                        }),
                      );
                    }}
                  >
                    {rule.enabled ? "Enabled" : "Disabled"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <div className="ds-filters">
        <label className="sub" htmlFor="rule-name">
          New rule
        </label>
        <input
          className="ds-input"
          id="rule-name"
          placeholder="Critical shortages, on call"
          value={name}
          disabled={pending}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <select
          className="ds-input"
          aria-label="Minimum severity"
          value={minSeverity}
          disabled={pending}
          onChange={(event) => {
            setMinSeverity(event.target.value);
          }}
        >
          {["low", "moderate", "high", "critical"].map((value) => (
            <option key={value} value={value}>
              {value} and above
            </option>
          ))}
        </select>
        <input
          className="ds-input ds-input--inline"
          aria-label="Cooldown in minutes"
          type="number"
          min={1}
          value={cooldown}
          disabled={pending}
          onChange={(event) => {
            setCooldown(event.target.value);
          }}
        />
        {["email", "chat"].map((channel) => (
          <label className="sub" key={channel}>
            <input
              type="checkbox"
              checked={channels.includes(channel)}
              disabled={pending}
              onChange={() => {
                setChannels((current) =>
                  current.includes(channel)
                    ? current.filter((value) => value !== channel)
                    : [...current, channel],
                );
              }}
            />{" "}
            {channel}
          </label>
        ))}
        <button
          type="button"
          className="ds-button"
          aria-disabled={blocked || undefined}
          title={unavailableReason ?? undefined}
          disabled={pending || name.trim().length === 0 || channels.length === 0}
          onClick={() => {
            run(async () => {
              await createAlertRuleAction({
                name: name.trim(),
                minSeverity,
                cooldownMinutes: Number(cooldown),
                channels,
              });
              setName("");
            });
          }}
        >
          Create rule
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
