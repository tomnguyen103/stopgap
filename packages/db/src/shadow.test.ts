import { describe, expect, it, vi } from "vitest";
import type { Db } from "./client.js";
import { hasShadowRunForReplay, recordShadowRun } from "./shadow.js";

const run = {
  orgId: "00000000-0000-0000-0000-000000000001",
  corpusId: "corpus-1",
  key: "heparin-1",
  proposedSeverity: "high",
  proposedAlternatives: ["alternative"],
  baselineSeverity: "high",
  baselineAlternatives: ["<alternative exists>"],
  agreement: "1.000",
  severityAgreed: true,
  severityUnderCalled: false,
  latencyMs: 10,
  usdCost: "0",
  provider: "ollama",
  modelId: "mistral",
  replayDay: "2026-08-01",
};

describe("recordShadowRun", () => {
  it("returns the existing sample when a replay day conflicts", async () => {
    const existing = { ...run, id: "existing" };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [existing] }),
        }),
      }),
    } as unknown as Db;

    await expect(recordShadowRun(run, db)).resolves.toEqual(existing);
  });

  it("returns the inserted sample on a new replay day", async () => {
    const inserted = { ...run, id: "inserted" };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [inserted] }),
        }),
      }),
    } as unknown as Db;

    await expect(recordShadowRun(run, db)).resolves.toEqual(inserted);
  });
});

describe("hasShadowRunForReplay", () => {
  it("checks the org, corpus item, and UTC replay day", async () => {
    const where = vi.fn();
    const db = {
      select: () => ({
        from: () => ({
          where: (...args: unknown[]) => {
            where(...args);
            return { limit: async () => [{ id: "existing" }] };
          },
        }),
      }),
    } as unknown as Db;

    await expect(hasShadowRunForReplay(run.orgId, run.corpusId, run.replayDay, db)).resolves.toBe(
      true,
    );
    expect(where).toHaveBeenCalledTimes(1);
  });

  it("returns false when the replay day has no row", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    } as unknown as Db;

    await expect(hasShadowRunForReplay(run.orgId, run.corpusId, run.replayDay, db)).resolves.toBe(
      false,
    );
  });
});
