import { generateStructured } from "@stopgap/providers";
import { UNTRUSTED_RECORD_NOTICE } from "./prompt.js";
import { DailyBrief } from "./schemas.js";

/** What the brief is written from — already-scored facts, never raw provider payloads. */
export interface BriefInput {
  /** Signals present in this tenant right now, highest score first. */
  current: { entity: string; domain: string; severity: string; score: number; title: string }[];
  /** Dedupe keys present in the previous brief's window, for the "what changed" half. */
  previousKeys: string[];
  /** Dedupe keys present now, in the same order as `current`. */
  currentKeys: string[];
  /** Cases sitting in a state that needs a human. */
  awaitingReview: { key: string; status: string }[];
  /** When the previous brief was generated, or undefined for the first one. */
  since?: string;
}

/**
 * Draft the daily brief (ticket 13).
 *
 * Runs on the EXISTING provider path — `generateStructured` — so it inherits health-check
 * failover, the cost and latency logging, and the established tracing without a second of any of
 * them. A brief is exactly the kind of feature that tempts a team into adopting a second
 * orchestration library; the observability fragmentation that follows costs more than the feature.
 *
 * The model NEVER computes a score or a severity. Every number in the input arrived from the
 * deterministic scorer, and the model's whole job is to say what they mean in English (ADR-0002).
 * Temperature is whatever the provider path sets; the schema is what makes the output usable.
 */
export async function draftDailyBrief(input: BriefInput): Promise<DailyBrief> {
  const appeared = input.currentKeys.filter((k) => !input.previousKeys.includes(k));
  const gone = input.previousKeys.filter((k) => !input.currentKeys.includes(k));
  const { object } = await generateStructured({
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
      input.since ? `Previous brief: ${input.since}` : "This is the first brief for this facility.",
      "",
      `Signals now (${String(input.current.length)}), highest risk first:`,
      ...input.current
        .slice(0, 25)
        .map(
          (s) =>
            `- ${s.entity} · ${s.domain} · ${s.severity} · score ${String(s.score)} — ${s.title}`,
        ),
      "",
      `Newly present since the previous brief: ${String(appeared.length)}`,
      `No longer present: ${String(gone.length)}`,
      "",
      `Cases awaiting a human decision (${String(input.awaitingReview.length)}):`,
      ...input.awaitingReview.map((c) => `- ${c.key} · ${c.status}`),
    ].join("\n"),
  });
  return object;
}
