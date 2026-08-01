import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assessImpact: vi.fn(),
  researchAlternatives: vi.fn(),
  recordShadowRun: vi.fn(),
  routeModel: vi.fn(),
  withOrgDb: vi.fn(),
}));

vi.mock("@stopgap/agents", () => ({
  NO_CATALOG_DATA: {},
  assessImpact: mocks.assessImpact,
  researchAlternatives: mocks.researchAlternatives,
}));
vi.mock("@stopgap/db", () => ({
  recordShadowRun: mocks.recordShadowRun,
  withOrgDb: mocks.withOrgDb,
}));
vi.mock("@stopgap/providers", () => ({ routeModel: mocks.routeModel }));

const { runShadowEntry } = await import("./run.js");
const entry = {
  id: "corpus-1",
  drugClass: "injectable",
  record: {
    genericName: "heparin",
    key: "heparin-1",
    source: "openfda",
    sourceId: "source-1",
    status: "current",
    ndcs: [],
    rxcuis: [],
  },
  baseline: { severity: "high", hasAlternative: true },
} as Parameters<typeof runShadowEntry>[1];

describe("runShadowEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withOrgDb.mockImplementation(async (_orgId, fn) => fn({}));
    mocks.recordShadowRun.mockResolvedValue({});
    mocks.assessImpact.mockResolvedValue({ severity: "high" });
    mocks.researchAlternatives.mockResolvedValue({ alternatives: ["alternative"] });
  });

  it("refuses a paid provider before scoring or writing evidence", async () => {
    mocks.routeModel.mockResolvedValue({
      info: { name: "gemini", modelId: "gemini-test", usdPer1mInput: 0.3, usdPer1mOutput: 2.5 },
    });

    await expect(runShadowEntry("org-1", entry, "2026-08-01")).rejects.toThrow(
      "shadow replay is local-provider only",
    );
    expect(mocks.assessImpact).not.toHaveBeenCalled();
    expect(mocks.recordShadowRun).not.toHaveBeenCalled();
  });

  it("writes the caller's UTC replay day so retries can conflict idempotently", async () => {
    mocks.routeModel.mockResolvedValue({
      info: { name: "ollama", modelId: "mistral", usdPer1mInput: 0, usdPer1mOutput: 0 },
    });

    await runShadowEntry("org-1", entry, "2026-08-01");

    expect(mocks.routeModel).toHaveBeenCalledWith("ollama", { allowFailover: false });
    expect(mocks.recordShadowRun).toHaveBeenCalledWith(
      expect.objectContaining({ corpusId: "corpus-1", replayDay: "2026-08-01", provider: "ollama" }),
      expect.anything(),
    );
    expect(mocks.assessImpact).toHaveBeenCalledWith(entry.record, {}, {
      provider: "ollama",
      allowFailover: false,
    });
    expect(mocks.researchAlternatives).toHaveBeenCalledWith(entry.record, {
      provider: "ollama",
      allowFailover: false,
    });
  });
});
