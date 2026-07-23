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

**Status:** in progress

Target deliverable: Temporal + Postgres (Drizzle) + live FDA/ASHP/RxNorm polling; AI SDK
provider routing (Gemini + Ollama, health-check failover); one shortage case end-to-end
with mocked activities; Next.js 15 console skeleton. Verified by: Temporal UI shows the
case, console renders it, time-skipped Temporal test proves a multi-week case resumes.

- [ ] Monorepo scaffold + local gate wiring
- [ ] docker-compose (Postgres + Temporal + UI)
- [ ] `@stopgap/db` — Drizzle schema (cases, audit) + migrations
- [ ] `@stopgap/providers` — provider registry + health-check failover
- [ ] `@stopgap/ingest` — real openFDA / ASHP / RxNorm clients + fixtures
- [ ] `@stopgap/workflows` — case workflow + mocked activities + time-skip test
- [ ] `apps/console` — Next.js 15 skeleton listing cases
- [ ] End-to-end: one case opens, visible in Temporal UI + console

## Phase 2 — Intelligence (weeks 2–4)

**Status:** not started

## Phase 3 — Memory + shadow (weeks 4–6)

**Status:** not started

## Phase 4 — Product (weeks 6–8)

**Status:** not started

---

## Merged-PR log

<!-- append one line per merged PR: ✅ <PR title> — <what it proved> -->
