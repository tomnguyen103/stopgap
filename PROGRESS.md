# Stopgap — Build Progress

Single source of truth: `PROJECT_PLAN.md`. This file tracks phase status against the
plan's build table (§13). Out of scope this run: Phase 5 (see `PHASE5-TODO.md`).

## Environment (verified 2026-07-23)

- node v24.15.0 · pnpm 10.34.5 · git 2.54 · Docker 29.6.2 (daemon up) · gh 2.93 (authed)
- Ollama 0.32.3 local; models present: `mistral`, `gemma4:12b`, `gemma4`, `qwen3.6`
- codegraph 0.9.8 · graphify 0.9.19
- **No `GEMINI_API_KEY` / `RESEND_API_KEY` / Langfuse keys in env** → those providers are
  stubbed; local gate + CI run on Ollama (as the plan intends). See `PHASE5-TODO.md`.

## Phase 1 — Spine (weeks 1–2)

**Status:** ✅ MERGED to main — [PR #1](https://github.com/tomnguyen103/stopgap/pull/1),
local gate green, e2e verified (backend + auto-poll + UI), CodeRabbit clean after 4
remediation rounds (21 real findings fixed across the whole branch, 3 architectural items
deferred to `PHASE5-TODO.md` with documented reasons).

**GitHub:** public repo `tomnguyen103/stopgap`; `main` pushed (scaffold baseline);
Actions **disabled** (verified `enabled:false`) per zero-Actions-minutes policy.

Target deliverable: Temporal + Postgres (Drizzle) + live FDA/ASHP/RxNorm polling; AI SDK
provider routing (Gemini + Ollama, health-check failover); one shortage case end-to-end
with mocked activities; Next.js 15 console skeleton. Verified by: Temporal UI shows the
case, console renders it, time-skipped Temporal test proves a multi-week case resumes.

- [x] Monorepo scaffold + local gate wiring (lint+typecheck+test+build, `--if-present`)
- [x] docker-compose (Postgres + Temporal + UI) — running locally
- [x] `@stopgap/db` — Drizzle schema (cases, audit, feed_records) + migrations applied
- [x] `@stopgap/providers` — Gemini+Ollama registry + health-check failover + telemetry sink
- [x] `@stopgap/ingest` — real openFDA/RxNorm clients + fixtures; ASHP client (stubbed w/o key); cross-feed dedupe
- [x] `@stopgap/workflows` — case workflow + mocked activities + time-skip test (4 pass)
- [x] `apps/console` — Next.js 15: case list + hash-chained audit detail page
- [x] `pollFeedsWorkflow` + Temporal Schedule (`start-schedule`, every 15m) — closes the
  "poll → auto-opens case" architecture gap (§4); idempotent via `REJECT_DUPLICATE`
- [x] End-to-end (backend): live openFDA → durable case → Postgres `awaiting_review`, severity `critical`, audit chain intact
- [x] End-to-end (auto-poll): manual `pollFeedsWorkflow` run against live openFDA+ASHP opened
  57 new cases with zero duplicates (pre-existing heparin case correctly skipped)
- [x] End-to-end (UI): heparin case visible in console (list row + detail page), verified in browser against local docker stack

## Phase 2 — Intelligence (weeks 2–4)

**Status:** in progress — core agents wired and verified live; Langfuse tracing and golden
dataset expansion (v1 has 4 cases, plan targets 60-100) still open.

Target deliverable: impact + alternatives agents, structured outputs, confidence routing;
golden dataset v1; Langfuse; eval CI gate on Ollama.

- [x] `@stopgap/agents` — Zod-validated `assessImpact`/`researchAlternatives` via
  `generateStructured` (Gemini/Ollama, health-routed), replacing Phase 1's deterministic mocks
- [x] Confidence routing: `research.confidence < 0.5` routes to the exception queue instead of
  auto-drafting a shaky protocol (PROJECT_PLAN §8: under-escalation target ≈ 0)
- [x] Golden dataset v1 (4 cases) + eval test running live against Ollama (`mistral`,
  temperature 0) as part of `pnpm test`/`pnpm gate` — no exact-match, severity-floor +
  alternative-existence checks tuned to a small local model's realistic ceiling
- [x] Verified live end-to-end: real Temporal worker (webpack bundle confirmed clean — the
  workflow-side import is an isolated `@stopgap/agents/schemas` subpath so provider/network
  code never enters the deterministic workflow sandbox) opened a fresh insulin-lispro case
  through the real agents: severity `critical`, full audit trail to `awaiting_review`
- [ ] Langfuse self-hosted + OTel GenAI tracing (currently: local console/no-op sink)
- [ ] Golden dataset expansion toward 60-100 cases
- [ ] Gemini-vs-Ollama comparison table (blocked on `GEMINI_API_KEY`, see `PHASE5-TODO.md`)

## Phase 3 — Memory + shadow (weeks 4–6)

**Status:** not started

## Phase 4 — Product (weeks 6–8)

**Status:** not started

---

## Merged-PR log

<!-- append one line per merged PR: ✅ <PR title> — <what it proved> -->
✅ Phase 1 — Spine: durable case engine, provider routing, live feeds ([#1](https://github.com/tomnguyen103/stopgap/pull/1)) — Temporal + Postgres + live openFDA/ASHP polling, Gemini/Ollama provider registry with failover, Next.js 15 console, `pollFeedsWorkflow` auto-opening cases (57 real cases opened live in verification), weekly-tick monitoring loop, retry-safe hash-chained audit log. 23/23 tests green, `pnpm gate` clean, CodeRabbit clean after 4 rounds.
