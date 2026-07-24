import { resetEnvCache } from "@stopgap/core/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiConfigured,
  caseInput,
  getCaseTool,
  getProtocolTool,
  getShadowStatsTool,
  listCasesInput,
  listCasesTool,
  resolveExceptionInput,
  resolveExceptionTool,
  reviewCaseInput,
  reviewCaseTool,
} from "./tools.js";

/**
 * MCP-through-API tests (PHASE6 §6.7 acceptance: "MCP server functions with only an API key, no
 * direct DB access"). `fetch` is mocked, so these assert the two properties that matter: with no
 * key every tool refuses HONESTLY rather than reaching for a database, and with a key every tool
 * carries the bearer credential to the right path.
 */

const fetchMock = vi.fn();

const KEY = "sk_live_test-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setEnv({ STOPGAP_API_KEY: undefined, STOPGAP_API_BASE_URL: undefined });
});

describe("with STOPGAP_API_KEY unset (honest non-configuration)", () => {
  beforeEach(() => {
    setEnv({ STOPGAP_API_KEY: undefined });
  });

  it("reports itself unconfigured", () => {
    expect(apiConfigured()).toBe(false);
  });

  it.each([
    ["list_cases", () => listCasesTool(listCasesInput.parse({}))],
    ["get_case", () => getCaseTool(caseInput.parse({ key: "cefazolin" }))],
    ["get_protocol", () => getProtocolTool(caseInput.parse({ key: "cefazolin" }))],
    ["get_shadow_stats", () => getShadowStatsTool()],
    [
      "resolve_exception",
      () =>
        resolveExceptionTool(
          resolveExceptionInput.parse({ key: "cefazolin", protocolBody: "use X", rationale: "why" }),
        ),
    ],
    [
      "review_case",
      () => reviewCaseTool(reviewCaseInput.parse({ key: "cefazolin", kind: "approve" })),
    ],
  ])("%s returns the not-configured result and issues NO request", async (_name, call) => {
    const result = (await call()) as { configured: false; message: string };
    expect(result.configured).toBe(false);
    // The message must tell the operator how to fix it, and must not imply a data answer.
    expect(result.message).toContain("STOPGAP_API_KEY");
    expect(result.message).toContain("/admin/api-keys");
    // The critical property: no silent fallback to reading the database directly.
    expect(result.message).toContain("no direct-database fallback");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("with STOPGAP_API_KEY set", () => {
  beforeEach(() => {
    setEnv({ STOPGAP_API_KEY: KEY, STOPGAP_API_BASE_URL: "http://console.test" });
  });

  /** The URL and init of the single fetch the tool under test performed. */
  function lastCall(): { url: string; init: RequestInit } {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    return { url: url.toString(), init };
  }

  it("reports itself configured", () => {
    expect(apiConfigured()).toBe(true);
  });

  it("list_cases GETs /api/v1/cases with the bearer key and maps the body through", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ cases: [{ key: "cefazolin" }] }));
    const result = await listCasesTool(listCasesInput.parse({ limit: 5 }));
    const { url, init } = lastCall();
    expect(url).toBe("http://console.test/api/v1/cases?limit=5");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(init.method).toBe("GET");
    expect(result).toEqual({ cases: [{ key: "cefazolin" }] });
  });

  it("get_case GETs the per-key path, URL-encoding the key", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ key: "sodium bicarbonate" }));
    await getCaseTool(caseInput.parse({ key: "sodium bicarbonate" }));
    expect(lastCall().url).toBe("http://console.test/api/v1/cases/sodium%20bicarbonate");
  });

  it("get_protocol GETs /api/v1/protocols/{key}", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ history: [] }));
    await getProtocolTool(caseInput.parse({ key: "cefazolin" }));
    expect(lastCall().url).toBe("http://console.test/api/v1/protocols/cefazolin");
  });

  it("get_shadow_stats GETs /api/v1/shadow/stats", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ classes: [] }));
    await getShadowStatsTool();
    expect(lastCall().url).toBe("http://console.test/api/v1/shadow/stats");
  });

  it("resolve_exception POSTs the resolution body to the case's endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, key: "cefazolin" }, 202));
    const result = await resolveExceptionTool(
      resolveExceptionInput.parse({
        key: "cefazolin",
        protocolBody: "substitute cefuroxime",
        alternatives: ["cefuroxime"],
        rationale: "same class",
      }),
    );
    const { url, init } = lastCall();
    expect(url).toBe("http://console.test/api/v1/cases/cefazolin/resolve-exception");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // The key travels in the path, not the body — the body is exactly the resolution.
    expect(JSON.parse(init.body as string)).toEqual({
      protocolBody: "substitute cefuroxime",
      alternatives: ["cefuroxime"],
      rationale: "same class",
    });
    expect(result).toEqual({ ok: true, key: "cefazolin" });
  });

  it("review_case POSTs an approve decision as the discriminated union the API expects", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, key: "cefazolin" }, 202));
    const result = await reviewCaseTool(reviewCaseInput.parse({ key: "cefazolin", kind: "approve" }));
    const { url, init } = lastCall();
    expect(url).toBe("http://console.test/api/v1/cases/cefazolin/review");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    // No stray `editedDraft: undefined` / `reason: undefined`: the flat tool input is reassembled
    // into exactly one arm of the union, which is what the API's discriminated schema accepts.
    expect(JSON.parse(init.body as string)).toEqual({ kind: "approve" });
    expect(result).toEqual({ ok: true, key: "cefazolin" });
  });

  it("review_case carries the edited draft on an edit, and the reason on a reject", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, key: "cefazolin" }, 202));
    await reviewCaseTool(
      reviewCaseInput.parse({ key: "cefazolin", kind: "edit", editedDraft: "use cefuroxime", reason: "ignored" }),
    );
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ kind: "edit", editedDraft: "use cefuroxime" });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, key: "cefazolin" }, 202));
    await reviewCaseTool(reviewCaseInput.parse({ key: "cefazolin", kind: "reject", reason: "dose is wrong" }));
    expect(JSON.parse(lastCall().init.body as string)).toEqual({ kind: "reject", reason: "dose is wrong" });
  });

  it("surfaces an unreachable console as a structured failure, not an unhandled rejection", async () => {
    // No Response at all — a stopped console, a wrong base URL, a dead network. Without the catch
    // in `callApi` this rejects and the MCP client shows the model an opaque transport string.
    fetchMock.mockRejectedValue(new Error("fetch failed"));
    const result = (await listCasesTool(listCasesInput.parse({ limit: 5 }))) as {
      ok: false;
      status: number;
      error: string;
      message: string;
    };
    expect(result).toMatchObject({ ok: false, error: "request_failed" });
    // `status: 0` — no HTTP exchange happened, so no status code may be claimed.
    expect(result.status).toBe(0);
    expect(result.message).toContain("http://console.test");
  });

  it("bounds the call with an abort signal so an unresponsive console cannot hang the tool", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ cases: [] }));
    await listCasesTool(listCasesInput.parse({ limit: 5 }));
    expect(lastCall().init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces a scope refusal as a structured failure, not a thrown transport error", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "forbidden", message: 'this API key does not carry the "protocols:write" scope' }, 403),
    );
    const result = (await resolveExceptionTool(
      resolveExceptionInput.parse({ key: "cefazolin", protocolBody: "x", rationale: "y" }),
    )) as { ok: false; status: number; error: string; message: string };
    expect(result).toMatchObject({ ok: false, status: 403, error: "forbidden" });
    expect(result.message).toContain("protocols:write");
  });
});
