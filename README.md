# Stopgap

Hospital drug-shortage response platform. AI agents turn the manual spreadsheet scramble
into a monitored, durable, human-approved substitution pipeline.

> **Non-diagnostic, administrative pharmacy ops. Zero PHI ever** — drug-level data only
> (shortage feeds, formulary, inventory). A pharmacist always approves. Outside FDA CDS
> device scope (Jan 2026 guidance). Architecture documented HIPAA-ready (RBAC, hash-chained
> audit, encryption) for credibility.

See [`PROJECT_PLAN.md`](PROJECT_PLAN.md) for the full plan and [`PROGRESS.md`](PROGRESS.md)
for build status.

## Architecture

```
FDA openFDA + ASHP feeds ──poll──▶ Ingest ──▶ Temporal workflow per shortage case
                                                ├─ assess impact (formulary/inventory — deterministic)
                                                ├─ research alternatives (agent via AI SDK, structured output)
                                                ├─ protocol memory lookup/draft
                                                ├─ HITL signal (pharmacist approve/edit/reject)
                                                ├─ comms out (email, EHR payload — idempotent)
                                                └─ monitor until resolution → reversion → close
Next.js console ◀── Postgres (cases, shadow ledger, protocols, audit, metrics)
Langfuse ◀── OTel GenAI traces from every LLM step
MCP server ──▶ pipeline tools (query case, approve, protocol lookup)
```

Deterministic Temporal spine owns the process; the LLM owns judgment only, behind
Zod-validated structured outputs and confidence routing. See
[ADR-0002](docs/adr/0002-deterministic-spine-probabilistic-organs.md).

## Model routing

Provider registry (`@stopgap/providers`): `gemini-3.5-flash-lite` (prod default) and a
local Ollama model (dev, CI, runtime fallback), with runtime health-check failover and
per-provider cost/latency logging. The eval suite runs against both; CI runs against
Ollama (zero API cost, temperature 0, pinned model).

## Stack

TypeScript · Next.js 15 · Node 22 · PostgreSQL 16 · Temporal TS SDK · Vercel AI SDK ·
Gemini 3.5 Flash Lite · Ollama · openFDA / ASHP / RxNorm · Medplum + Synthea (mock
formulary/inventory) · Langfuse + OpenTelemetry GenAI · MCP TS SDK · Zod · Drizzle ·
Resend · Docker Compose · Vitest + Playwright · PostHog.

## Local development

Prerequisites: Node 22+, pnpm, Docker Desktop, Ollama (with a local model, e.g. `mistral`).

```bash
pnpm install
cp .env.example .env          # fill secrets; missing LLM keys fall back to Ollama
pnpm infra:up                 # Postgres + Temporal + Temporal UI (http://localhost:8233)
pnpm db:migrate               # apply Drizzle migrations
pnpm gate                     # lint + typecheck + test + build (the CI gate)
```

Run the worker and console:

```bash
pnpm worker                   # Temporal worker
pnpm console                  # Next.js console at http://localhost:3000
```
