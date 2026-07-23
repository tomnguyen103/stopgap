import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@stopgap/core/env";
import { langfuseOtlpEndpoint, isTracingConfigured } from "./tracing.js";

afterEach(() => {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  resetEnvCache();
});

describe("langfuseOtlpEndpoint", () => {
  it("builds the OTLP trace path", () => {
    expect(langfuseOtlpEndpoint("http://localhost:3001")).toBe(
      "http://localhost:3001/api/public/otel/v1/traces",
    );
  });

  it("tolerates a trailing slash on the base URL", () => {
    expect(langfuseOtlpEndpoint("https://cloud.langfuse.com/")).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });
});

describe("isTracingConfigured", () => {
  it("is false without credentials, so the gate runs with zero configuration", () => {
    resetEnvCache();
    expect(isTracingConfigured()).toBe(false);
  });

  it("needs both keys — a public key alone cannot authenticate the exporter", () => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-test";
    resetEnvCache();
    expect(isTracingConfigured()).toBe(false);
    process.env.LANGFUSE_SECRET_KEY = "sk-lf-test";
    resetEnvCache();
    expect(isTracingConfigured()).toBe(true);
  });
});
