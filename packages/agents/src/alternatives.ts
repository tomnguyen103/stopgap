import type { ShortageRecord } from "@stopgap/core";
import { generateStructured } from "@stopgap/providers";
import { formatRecordPrompt, UNTRUSTED_RECORD_NOTICE } from "./prompt.js";
import { AlternativesResearch } from "./schemas.js";

/**
 * Research therapeutic alternatives and draft a substitution protocol. Deterministic
 * (temperature 0) so the offline eval gate is reproducible against Ollama.
 */
export async function researchAlternatives(record: ShortageRecord): Promise<AlternativesResearch> {
  const { object } = await generateStructured({
    schema: AlternativesResearch,
    operation: "research-alternatives",
    system:
      "You are a hospital pharmacy alternatives-research agent for a drug-shortage response " +
      "platform. Most drugs DO have therapeutic alternatives (a different agent in the same " +
      "class, an alternate manufacturer, or a different dosage form) — actively name them " +
      "using your clinical pharmacology knowledge; an empty list should be rare. Only return " +
      "an empty alternatives list and empty draft for drugs with genuinely no safe substitute " +
      "(e.g. plasma-derived products like immune globulin, or compounded preparations). Draft " +
      "a brief substitution protocol for pharmacist review. Report low confidence when you are " +
      "unsure of a specific alternative, but still name your best clinical guess rather than " +
      `defaulting to an empty list. ${UNTRUSTED_RECORD_NOTICE}`,
    prompt: formatRecordPrompt(record, [
      `RxCUIs: ${record.rxcuis.length > 0 ? record.rxcuis.join(", ") : "none reported"}`,
    ]),
  });
  return object;
}
