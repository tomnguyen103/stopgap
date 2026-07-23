import type { ShortageRecord } from "@stopgap/core";

/** Common shortage-record fields both judgment agents' prompts need. */
export function formatRecordPrompt(record: ShortageRecord, extraLines: string[] = []): string {
  return [
    `Generic name: ${record.genericName}`,
    `Status: ${record.status}`,
    `Affected NDCs: ${record.ndcs.length > 0 ? record.ndcs.join(", ") : "none reported"}`,
    ...extraLines,
    `Feed note: ${record.note ?? "none"}`,
  ].join("\n");
}
