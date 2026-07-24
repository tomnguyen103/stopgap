# ADR 0003 — Vendor-neutral OTel GenAI spans into self-hosted Langfuse

**Status:** accepted (Phase 2)

## Context

PROJECT_PLAN §9 requires LLM observability: per-call cost, latency, provider, and whether a
call fell back from Gemini to local Ollama. Langfuse is the chosen backend, self-hosted so
the run costs nothing and no clinical prompt content leaves the machine.

Two ways to get data in: the Langfuse SDK (vendor-specific `trace`/`generation` objects
wrapped around every call site), or OpenTelemetry — Langfuse ingests OTLP directly at
`/api/public/otel/v1/traces` with HTTP Basic auth over a project key pair.

## Decision

Emit **OTel spans using the GenAI semantic conventions** and point the OTLP exporter at
self-hosted Langfuse.

- `@stopgap/observability` owns the tracer provider, the exporter, and the span shape.
- The span is built from the provider layer's existing `LlmCallRecord` through the existing
  `setLlmSink` hook and backdated by the recorded latency, so `generateStructured` stays free
  of tracing code and every LLM call is covered by construction (ADR-0002: all LLM judgment
  goes through that one function).
- GenAI attribute names are written as string literals rather than imported from
  `@opentelemetry/semantic-conventions/incubating`: the GenAI group is still incubating and
  renames its exported symbols between minor releases, while the wire attribute names that
  backends key on are stable.
- Tracing is **off** unless both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set — no
  exporter, no background flush timer. The local gate and offline evals run unconfigured.
- Langfuse's containers sit behind a `langfuse` compose profile, so `docker compose up -d`
  still starts only the Phase 1 spine (Langfuse v3 additionally needs ClickHouse, Redis and
  S3-compatible storage).

## Consequences

- Swapping Langfuse for any other OTLP backend is a URL change, not a code change; the
  spans carry no Langfuse-specific shape beyond one `langfuse.observation.type` hint that
  makes the trace render as a generation.
- Spans are recorded after the call completes rather than opened around it, so there are no
  streaming/partial-token spans and no parent-child nesting under a case workflow yet.
  Per-case trace grouping (one Langfuse trace per shortage case, spans per agent step) is
  Phase 3 work — it needs the Temporal workflow id propagated into the activity context.
- Prompt and completion text are deliberately **not** attached to spans. Feed records are
  untrusted upstream text and drafts are clinical content; shipping them into an analytics
  store is a privacy decision that belongs in the Phase 4 review, not a side effect of
  turning on cost tracking.

## Verified

`packages/observability/scripts/verify-trace.ts` ran one real `assessImpact` call against
local Ollama with the profile up; the span arrived in Langfuse with
`gen_ai.system=ollama`, `gen_ai.request.model=mistral`, input/output token counts and
3.17 s latency (queried back through Langfuse's public API).
