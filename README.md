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

### LLM tracing (optional)

Self-hosted Langfuse is behind a compose profile, so it never starts with the default spine:

```bash
docker compose --profile langfuse up -d    # Langfuse UI on http://localhost:3001
```

The profile seeds a local project (`LANGFUSE_INIT_*` in `docker-compose.yml`). Put its key
pair in `.env` and every LLM call emits an OTel GenAI span with provider, model, tokens,
cost, latency and whether the call failed over — see
[ADR 0003](docs/adr/0003-otel-genai-tracing-to-self-hosted-langfuse.md). Without both keys,
tracing is off entirely.

### Evals

```bash
pnpm eval                     # golden-dataset subset + injection cases, live on Ollama
pnpm eval:full                # all golden cases (slow: hundreds of local model calls)
```

Evals run **outside** `pnpm gate` on purpose — small local models aren't fully deterministic
even at temperature 0, so a hard build gate on live-model output would train everyone to
ignore red. `pnpm gate` stays deterministic; `pnpm eval` reports the real signal.

## Deployment & demo mode

A single-VPS `docker compose` stack lives in [`deploy/`](deploy) — console, worker, Temporal
+ UI, one Postgres with three databases, Langfuse, a CPU Ollama, and Caddy for TLS. The
runbook is [`docs/deploy.md`](docs/deploy.md); the stack was rehearsed end to end on a local
Docker daemon, and no paid host has been provisioned.

`STOPGAP_DEMO_MODE=on` makes the console a public read-only surface: reviews and exception
resolutions are refused in the server action (not merely hidden), and the only visitor
mutation is **"Run a shortage"**, which starts a real Temporal case for one of three
catalogue drugs, rate limited per hour (deployment-wide, not per visitor — without auth there
is no honest way to tell visitors apart). Every LLM call's cost accumulates in an `llm_spend`
row; if `LLM_DAILY_USD_CAP` is set, routing past it is restricted to the free local model and
the banner says which model is answering. That cap applies to every deployment, not just the
demo, and is off unless configured.
