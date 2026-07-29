import { generateStructured } from "@stopgap/providers";
import { escapeRecordValue, UNTRUSTED_RECORD_NOTICE } from "./prompt.js";
import { DailyBrief } from "./schemas.js";

/** One scored signal, as the brief sees it. */
export interface BriefSignal {
  entity: string;
  domain: string;
  severity: string;
  /** The deterministic scorer's 0-100 figure, or undefined when this signal has no snapshot yet. */
  score: number | undefined;
  title: string;
  /** Dedupe key — how this signal is matched against the previous brief's set. */
  key: string;
}

/** What the brief is written from — already-scored facts, never raw provider payloads. */
export interface BriefInput {
  /** Signals present in this tenant right now, highest score first. */
  current: BriefSignal[];
  /** Dedupe keys present in the previous brief's window, for the "what changed" half. */
  previousKeys: string[];
  /** Cases sitting in a state that needs a human, LONGEST-WAITING FIRST — see `LISTED_REVIEW_CASES`. */
  awaitingReview: { key: string; status: string }[];
  /** The date of the previous brief, or undefined for the first one. */
  since?: string;
}

export interface DraftedBrief {
  brief: DailyBrief;
  /** `provider:model-id` of the call that actually ran, failover included. Recorded on the row. */
  model: string;
}

/** How many signals are listed by name. Beyond this they are counted, to bound the prompt. */
const LISTED_SIGNALS = 25;
/**
 * The same bound for cases awaiting a human. Without it one tenant's backlog decides the prompt
 * size: a few hundred parked cases push the request past the provider's context limit, and a day
 * that had more to say than usual is exactly the day the brief comes back degraded.
 *
 * The cap keeps the LONGEST-WAITING cases, which is why `awaitingReview` arrives in that order.
 * Cutting from that end instead would hide precisely the cases the section exists to surface —
 * a case parked for three weeks needs a human more than one opened this morning.
 */
const LISTED_REVIEW_CASES = 25;

/**
 * Wrap upstream text in the `<record>` boundary the system instruction classifies as untrusted, with
 * the XML-special characters escaped so no value can close the boundary early. A signal's `entity`
 * and `title` are feed content nobody here wrote, and a case key is derived from one — interpolating
 * them bare puts attacker-chosen text where the model reads it as instructions (CWE-74/1427).
 *
 * The escaping happens HERE rather than at each call site, matching `formatRecordPrompt`: a boundary
 * that depends on every caller remembering to escape is a boundary that holds until someone adds a
 * field. The separators the callers interleave (`·`, `—`, a score) contain no XML-special character,
 * so escaping the assembled line is the same thing as escaping each value in it.
 */
function record(fields: string): string {
  return `<record>${escapeRecordValue(fields)}</record>`;
}

/**
 * Draft the daily brief (ticket 13).
 *
 * Runs on the EXISTING provider path — `generateStructured` — so it inherits health-check
 * failover, the cost and latency logging, and the established tracing without a second of any of
 * them.
 *
 * The model NEVER computes a score or a severity. Every number in the input arrived from the
 * deterministic scorer, and the model's whole job is to say what they mean in English (ADR-0002).
 * Temperature is whatever the provider path sets; the schema is what makes the output usable.
 */
export async function draftDailyBrief(input: BriefInput): Promise<DraftedBrief> {
  const previous = new Set(input.previousKeys);
  const currentKeys = new Set(input.current.map((s) => s.key));
  // NAMES, NOT COUNTS. The system prompt forbids inventing anything absent from the input, so a
  // bare "3 newly present" leaves the model nothing to write a specific "what changed" from — it
  // can only restate the number. Signals that DISAPPEARED have no name here: a dedupe key is
  // `org:source:source-id`, and the row it named is the one no longer in the current set.
  const appeared = input.current.filter((s) => !previous.has(s.key));
  const goneCount = input.previousKeys.filter((k) => !currentKeys.has(k)).length;
  const line = (s: BriefSignal) =>
    `- ${record(
      `${s.entity} · ${s.domain} · ${s.severity} · ` +
        `${s.score === undefined ? "not scored yet" : `score ${String(s.score)}`} — ${s.title}`,
    )}`;
  const caseLine = (c: { key: string; status: string }) => `- ${record(`${c.key} · ${c.status}`)}`;

  const { object, meta } = await generateStructured({
    schema: DailyBrief,
    operation: "daily-brief",
    system:
      "You write a daily supply-risk brief for a hospital pharmacy director. Summarise what " +
      "changed, what is newly at risk, and what needs a human decision. Be specific and short: " +
      "a director reads this between other things. NEVER invent a number, a drug, a count or a " +
      "date that is not in the input — an invented figure in a brief is indistinguishable from a " +
      "real one to the person reading it. NEVER state a dose, an administration rate or a route: " +
      "this is a situation report, not clinical guidance, and the pharmacist decides treatment. " +
      "Do not address the reader as a patient or give instructions about anyone's care. " +
      `${UNTRUSTED_RECORD_NOTICE}`,
    prompt: [
      input.since
        ? `Previous brief: ${input.since}`
        : "This is the first brief for this facility.",
      "",
      `Signals now (${String(input.current.length)}), highest risk first:`,
      ...input.current.slice(0, LISTED_SIGNALS).map(line),
      "",
      `Newly present since the previous brief (${String(appeared.length)}):`,
      ...appeared.slice(0, LISTED_SIGNALS).map(line),
      "",
      `No longer present: ${String(goneCount)}`,
      "",
      `Cases awaiting a human decision (${String(input.awaitingReview.length)}):`,
      ...input.awaitingReview.slice(0, LISTED_REVIEW_CASES).map(caseLine),
    ].join("\n"),
  });
  // `meta` also went to the telemetry sinks inside `generateStructured` — provider, model, token
  // counts, cost and latency. Recording the model on the row too is the same reason a score
  // carries its scorer version: a brief that reads oddly is only diagnosable if you know who wrote it.
  return { brief: object, model: `${meta.provider}:${meta.modelId}` };
}
