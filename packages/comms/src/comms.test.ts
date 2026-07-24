import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@stopgap/core/env";
import { sendEhrFlag, sendEmail } from "./index.js";

const message = {
  idempotencyKey: "case-heparin:run-1:email",
  subject: "Drug shortage protocol: heparin sodium",
  body: "Switch to argatroban per protocol.",
  to: ["pharmacy@example.test"],
};

beforeEach(() => {
  // A developer's real distribution list in the ambient environment would otherwise turn the
  // "no recipients" case into a delivery and quietly void the assertion.
  delete process.env.COMMS_PHARMACY_TO;
  delete process.env.COMMS_DEMO_INBOX;
  delete process.env.RESEND_API_KEY;
  resetEnvCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.COMMS_PHARMACY_TO;
  delete process.env.COMMS_DEMO_INBOX;
  resetEnvCache();
});

describe("sendEmail", () => {
  it("reports a non-delivery instead of a silent success when no API key is set", async () => {
    resetEnvCache();
    const result = await sendEmail(message);
    expect(result).toEqual({
      channel: "email",
      delivered: false,
      reason: "RESEND_API_KEY not configured",
    });
  });

  it("reports a non-delivery when there is nobody to send to", async () => {
    process.env.RESEND_API_KEY = "re_test";
    resetEnvCache();
    const result = await sendEmail({ ...message, to: [] });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("no recipients configured");
  });

  it("passes the idempotency key to the transport so a retry cannot double-send", async () => {
    process.env.RESEND_API_KEY = "re_test";
    resetEnvCache();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: "msg_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendEmail(message);
    expect(result).toEqual({ channel: "email", delivered: true, providerId: "msg_1" });
    const headers = (fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(headers["idempotency-key"]).toBe(message.idempotencyKey);
  });

  it("uses the configured distribution list when the caller passes no explicit recipients", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.COMMS_PHARMACY_TO = "one@example.test, two@example.test";
    resetEnvCache();
    const listMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", listMock);
    await sendEmail({ ...message, to: [] });
    const listBody = JSON.parse((listMock.mock.calls[0]?.[1] as { body: string }).body) as { to: string[] };
    expect(listBody.to).toEqual(["one@example.test", "two@example.test"]);
  });

  it("falls back to the demo inbox when nothing else is configured", async () => {
    process.env.RESEND_API_KEY = "re_test";
    process.env.COMMS_DEMO_INBOX = "demo@example.test";
    resetEnvCache();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);

    await sendEmail({ ...message, to: [] });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as { to: string[] };
    expect(body.to).toEqual(["demo@example.test"]);
  });

  it("turns a transport failure into a recorded non-delivery, not a thrown case failure", async () => {
    process.env.RESEND_API_KEY = "re_test";
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const result = await sendEmail(message);
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("network down");
  });

  it("does not treat a non-2xx response as delivered", async () => {
    process.env.RESEND_API_KEY = "re_test";
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) }));
    const result = await sendEmail(message);
    expect(result).toEqual({ channel: "email", delivered: false, reason: "resend responded 429" });
  });
});

describe("sendEhrFlag", () => {
  it("posts the substitution and reports delivery", async () => {
    resetEnvCache();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    const result = await sendEhrFlag({
      idempotencyKey: "case-heparin:run-1:ehr",
      key: "heparin sodium",
      alternatives: ["Argatroban"],
      body: "Switch to argatroban per protocol.",
    });
    expect(result).toEqual({ channel: "ehr", delivered: true });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      key: string;
      alternatives: string[];
    };
    expect(body).toMatchObject({ key: "heparin sodium", alternatives: ["Argatroban"] });
  });

  it("records an unreachable EHR endpoint rather than failing the case", async () => {
    resetEnvCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await sendEhrFlag({
      idempotencyKey: "k",
      key: "heparin sodium",
      alternatives: [],
      body: "text",
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("ECONNREFUSED");
  });
});
