# ADR-0002: Deterministic Temporal spine, probabilistic LLM organs

- Status: Accepted
- Date: 2026-07-23

## Context

Stopgap automates the hospital drug-shortage response loop: detect → assess impact →
find alternative → draft protocol → HITL approve → communicate → track to resolution
(PROJECT_PLAN.md §2). Cases live weeks–months. LLM output is non-deterministic and can
be wrong on clinically consequential judgments (dose ratios, therapeutic equivalence).

## Decision

- **Temporal owns the process.** One durable workflow per shortage case. The workflow —
  not the model — decides state transitions, retries, HITL gating, and terminal state.
  Deterministic activities (formulary/inventory impact match) are plain code.
- **The LLM owns judgment only**, inside activities, behind schema-validated boundaries:
  - All model outputs go through `generateObject` with a Zod schema (structured output).
  - Confidence thresholds route low-confidence results to a human (refuse/abstain).
  - Iteration caps bound agent loops.
- **Provider routing is a first-class layer** (`@stopgap/providers`): a registry exposing
  `gemini-3.5-flash-lite` (prod default) and a local Ollama model (dev, CI, runtime
  fallback), with a runtime health check and automatic failover. Per-provider cost and
  latency are recorded. The eval suite runs against both providers.
- **CI runs the agent suite against Ollama** — zero API cost, deterministic offline
  (temperature 0, pinned local model).

## Consequences

- Correctness-critical control flow is testable and replayable independent of the model.
- Model choice is swappable; a missing `GEMINI_API_KEY` degrades to Ollama, never blocks.
- Every LLM step emits a structured object or an explicit abstention — no free-text
  clinical decisions reach a human without a schema and a confidence score.
