import { describe, expect, it } from "vitest";

import { redactDetail } from "./connector-runs.js";

/**
 * `detail` is a raw `Error.message` from a network client that gets STORED and then RENDERED on an
 * administrator's page, and one shared fetch error is copied into every tenant's row — so a client
 * that ever echoes the request it failed on would put a credential on every hospital's page at
 * once. These assert the boundary that stops it, with the credential shapes these connectors
 * actually carry: an openFDA key in a query string, a chat webhook URL, an SMTP bearer token.
 */
describe("redacting a connector failure before it is stored", () => {
  it("strips a secret-bearing query parameter but keeps the rest of the message", () => {
    const redacted = redactDetail(
      "openFDA 429 for https://api.fda.gov/drug/shortages.json?api_key=sk-live-abc123&limit=100",
    );
    expect(redacted).not.toContain("sk-live-abc123");
    // The DIAGNOSTIC survives: an administrator still has to be able to tell a rate limit from a
    // DNS failure, and a message redacted down to nothing is the same as no message.
    expect(redacted).toContain("429");
    expect(redacted).toContain("limit=100");
  });

  it("strips the credential from a userinfo URL", () => {
    const redacted = redactDetail("connect ECONNREFUSED smtp://mailer:hunter2@smtp.internal:587");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("ECONNREFUSED");
  });

  it("strips a bearer token", () => {
    expect(redactDetail("401 Unauthorized (Bearer eyJhbGciOiJIUzI1NiJ9.abc)")).not.toContain(
      "eyJhbGciOiJIUzI1NiJ9",
    );
  });

  it("strips a chat webhook path, which IS the credential", () => {
    const redacted = redactDetail(
      "POST https://hooks.slack.com/services/T000/B000/XXXXsecretXXXX failed",
    );
    expect(redacted).not.toContain("XXXXsecretXXXX");
    expect(redacted).toContain("hooks.slack.com/services");
  });

  it("bounds an unbounded provider error, and says that it did", () => {
    const redacted = redactDetail("x".repeat(5_000));
    expect(redacted.length).toBeLessThan(600);
    // Marked rather than silently cut: a truncated message that looks whole is read as whole.
    expect(redacted).toContain("(truncated)");
  });

  it("leaves an ordinary message alone", () => {
    expect(redactDetail("ASHP feed returned 503")).toBe("ASHP feed returned 503");
  });
});
