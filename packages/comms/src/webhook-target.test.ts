import { describe, expect, it } from "vitest";

import { refuseWebhookTarget } from "./webhook-target.js";

describe("what a chat webhook may point at", () => {
  it("accepts an ordinary https endpoint", () => {
    expect(refuseWebhookTarget("https://hooks.example.com/services/T000/B000/xxxx")).toBeNull();
  });

  it("refuses plain http, which puts the webhook's secret on the wire", () => {
    expect(refuseWebhookTarget("http://hooks.example.com/x")).toMatch(/https/);
  });

  it("refuses the cloud metadata address", () => {
    // The canonical server-side request forgery target: the poll would fetch instance credentials
    // on the tenant's behalf, and the response never has to come back for that to matter.
    expect(refuseWebhookTarget("https://169.254.169.254/latest/meta-data/")).toMatch(/network/);
  });

  it("refuses loopback and private ranges", () => {
    for (const host of [
      "https://127.0.0.1/x",
      "https://localhost:5432/x",
      "https://10.0.0.5/x",
      "https://172.16.4.1/x",
      "https://192.168.1.1/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
    ]) {
      expect(refuseWebhookTarget(host), host).toMatch(/network/);
    }
  });

  it("refuses credentials embedded in the URL", () => {
    expect(refuseWebhookTarget("https://user:pass@hooks.example.com/x")).toMatch(/credentials/);
  });

  it("refuses something that is not a URL at all", () => {
    expect(refuseWebhookTarget("hooks.example.com/x")).toBeTruthy();
    expect(refuseWebhookTarget("")).toBeTruthy();
  });

  it("does not pretend to resolve names", () => {
    // A name that resolves to a private address is NOT caught here, deliberately: resolution
    // happens at connect time and can change between the check and the call. The honest scope is
    // the literal target; egress control for names belongs in the network.
    expect(refuseWebhookTarget("https://internal-hooks.example.com/x")).toBeNull();
  });
});
