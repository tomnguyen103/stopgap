"use client";

import { useState, useTransition } from "react";

import { createAlertRuleAction, updateAlertRuleAction } from "../../lib/actions";
import { Button, Table } from "../../components/ui";

export interface RuleView {
  id: string;
  name: string;
  enabled: boolean;
  minSeverity: string;
  cooldownMinutes: number;
  channels: string[];
  riskDomain: string | null;
  entityContains: string | null;
  /**
   * WHETHER the rule has a chat webhook — never the webhook itself.
   *
   * A chat webhook is a bearer token: whoever holds the url can post as the integration. Props of a
   * client component are serialized into the payload the browser receives, so the url would sit in
   * page source for anyone who opened this page. The panel never displayed it and never needed it;
   * it needs only to say when a chat rule has no destination, because such a rule fails QUIETLY,
   * which is the failure mode alerting exists to prevent.
   *
   * Edits therefore OMIT the field, and `updateAlertRule` treats omitted as unchanged (only an
   * explicit null clears it) — so the value survives every edit without ever leaving the server.
   */
  hasChatWebhook: boolean;
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
  /**
   * The control's own name AND the reason it is refused, composed the way
   * `components/role-gated.tsx` composes them.
   *
   * A bare reason would REPLACE the accessible name, so a screen reader would announce "Needs the
   * pharmacy director role" without saying which control it belongs to — the reason arrives and the
   * identity goes, which is not an improvement on the tooltip. Undefined when allowed, so the
   * element keeps its own text.
   */
  const gatedLabel = (name: string) =>
    unavailableReason ? `${name} — ${unavailableReason}` : undefined;
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | undefined>();
  // Cooldown edits are CONTROLLED, keyed by rule. With an uncontrolled input the toggle button
  // beside it sends the value from props, so typing 30 and then clicking Enabled wrote 30 on blur
  // and immediately wrote the old number back.
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [name, setName] = useState("");
  const [minSeverity, setMinSeverity] = useState("high");
  const [cooldown, setCooldown] = useState("60");
  const [channels, setChannels] = useState<string[]>(["email"]);
  const [webhook, setWebhook] = useState("");

  /** The whole rule as the server takes it, with one field replaced. */
  function settings(rule: RuleView, change: Partial<RuleView>) {
    const merged = { ...rule, ...change };
    return {
      name: merged.name,
      minSeverity: merged.minSeverity,
      cooldownMinutes: merged.cooldownMinutes,
      channels: merged.channels,
      riskDomain: merged.riskDomain,
      entityContains: merged.entityContains,
      // DELIBERATELY ABSENT. Omitted means unchanged, which is how the credential is preserved
      // across an edit without this component ever having held it.
      enabled: merged.enabled,
    };
  }

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

      <Table
        head={["Rule", "Fires at", "Cooldown", "Channels", "Last fired", "State"]}
        label="Alert rules"
      >
        {rules.length === 0 ? (
          <tr>
            <td colSpan={6} className="is-subtle">
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
                  value={cooldowns[rule.id] ?? rule.cooldownMinutes}
                  disabled={pending}
                  aria-disabled={blocked || undefined}
                  title={unavailableReason ?? undefined}
                  aria-label={gatedLabel(`cooldown minutes for ${rule.name}`)}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setCooldowns((current) => ({ ...current, [rule.id]: next }));
                  }}
                  onBlur={() => {
                    const next = cooldowns[rule.id] ?? rule.cooldownMinutes;
                    if (next === rule.cooldownMinutes) return;
                    run(() =>
                      updateAlertRuleAction(rule.id, settings(rule, { cooldownMinutes: next })),
                    );
                  }}
                />
              </td>
              <td>
                {rule.channels.join(", ")}
                {/* A chat rule with no destination does not error — it silently pages nobody,
                      which is the one failure alerting cannot afford to keep to itself. */}
                {rule.channels.includes("chat") && !rule.hasChatWebhook ? (
                  <span className="sub"> · no webhook set — this rule pages nobody</span>
                ) : null}
              </td>
              <td className="is-subtle">{rule.lastFired ?? "never"}</td>
              <td>
                <Button
                  type="button"
                  className="ds-button ds-button--quiet"
                  aria-disabled={blocked || undefined}
                  title={unavailableReason ?? undefined}
                  aria-label={gatedLabel(rule.enabled ? "Enabled" : "Disabled")}
                  disabled={pending}
                  onClick={() => {
                    // The cooldown from the box, not from props: an unsaved edit sitting in the
                    // input must not be reverted by a toggle on the same row.
                    run(() =>
                      updateAlertRuleAction(
                        rule.id,
                        settings(rule, {
                          enabled: !rule.enabled,
                          cooldownMinutes: cooldowns[rule.id] ?? rule.cooldownMinutes,
                        }),
                      ),
                    );
                  }}
                >
                  {rule.enabled ? "Enabled" : "Disabled"}
                </Button>
              </td>
            </tr>
          ))
        )}
      </Table>

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
        {channels.includes("chat") ? (
          <input
            className="ds-input"
            aria-label="Chat webhook URL"
            type="url"
            placeholder="https://chat.example/hooks/…"
            value={webhook}
            disabled={pending}
            onChange={(event) => {
              setWebhook(event.target.value);
            }}
          />
        ) : null}
        <Button
          type="button"
          className="ds-button"
          aria-disabled={blocked || undefined}
          title={unavailableReason ?? undefined}
          aria-label={gatedLabel("Create rule")}
          disabled={
            pending ||
            name.trim().length === 0 ||
            channels.length === 0 ||
            // A chat rule with no destination delivers nothing and says it fired. Refused here
            // rather than accepted and left to fail at send time.
            (channels.includes("chat") && webhook.trim().length === 0)
          }
          onClick={() => {
            run(async () => {
              await createAlertRuleAction({
                name: name.trim(),
                minSeverity,
                cooldownMinutes: Number(cooldown),
                channels,
                chatWebhookUrl: channels.includes("chat") ? webhook.trim() : null,
              });
              setName("");
              setWebhook("");
            });
          }}
        >
          Create rule
        </Button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
