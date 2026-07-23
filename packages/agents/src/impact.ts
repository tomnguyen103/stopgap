import type { ShortageRecord } from "@stopgap/core";
import { generateStructured } from "@stopgap/providers";
import { formatRecordPrompt } from "./prompt.js";
import { ImpactAssessment } from "./schemas.js";

/**
 * Assess the clinical/operational impact of a shortage. Deterministic (temperature 0) so
 * the offline eval gate is reproducible against Ollama.
 */
export async function assessImpact(record: ShortageRecord): Promise<ImpactAssessment> {
  const { object } = await generateStructured({
    schema: ImpactAssessment,
    operation: "assess-impact",
    system:
      "You are a hospital pharmacy impact-assessment agent for a drug-shortage response " +
      "platform. Given a drug shortage record, rate its severity and explain why. Be " +
      "conservative: when the record is ambiguous or you lack enough information, report " +
      "low confidence rather than guessing.",
    prompt: formatRecordPrompt(record),
  });
  return object;
}
