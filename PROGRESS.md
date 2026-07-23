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

**Status:** ✅ MERGED — [PR #2](https://github.com/tomnguyen103/stopgap/pull/2) (agents,
confidence routing, eval gate), CodeRabbit clean after 3 rounds. Langfuse tracing and the
golden-dataset expansion shipped after the merge (see PR #3).

Target deliverable: impact + alternatives agents, structured outputs, confidence routing;
golden dataset v1; Langfuse; eval CI gate on Ollama.

- [x] `@stopgap/agents` — Zod-validated `assessImpact`/`researchAlternatives` via
  `generateStructured` (Gemini/Ollama, health-routed), replacing Phase 1's deterministic mocks
- [x] Confidence routing: `research.confidence < 0.5` routes to the exception queue instead of
  auto-drafting a shaky protocol (PROJECT_PLAN §8: under-escalation target ≈ 0)
- [x] Golden dataset v1 (4 cases) + `pnpm eval` (separate from `pnpm gate`/`pnpm test` — see
  `vitest.eval.config.ts`) running live against Ollama (`mistral`, temperature 0).
  Deliberately non-blocking: live runs showed the same case can flip pass/fail between
  identical runs (small quantized model inference isn't fully deterministic even at
  temperature 0) — a hard gate on that noise would just teach everyone to ignore red.
  `pnpm gate` stays deterministic/green (verified 3x); `pnpm eval` reports the real signal.
- [x] Prompt-injection defense (`<record>` delimiter + untrusted-data notice) + adversarial
  eval fixtures (`injection.eval.ts`) — catches a fabricated-substitute attack most runs;
  does NOT reliably stop a direct "output critical/1.0" attack against mistral (documented,
  not hidden — small local models have weaker instruction-hierarchy training than
  Gemini-class models). Full injection suite is PROJECT_PLAN §13 Phase 4 scope.
- [x] Verified live end-to-end: real Temporal worker (webpack bundle confirmed clean — the
  workflow-side import is an isolated `@stopgap/agents/schemas` subpath so provider/network
  code never enters the deterministic workflow sandbox) opened a fresh insulin-lispro case
  through the real agents: severity `critical`, full audit trail to `awaiting_review`
- [x] Langfuse self-hosted (compose `langfuse` profile) + OTel GenAI tracing via
  `@stopgap/observability` ([ADR-0003](docs/adr/0003-otel-genai-tracing-to-self-hosted-langfuse.md)).
  Verified live: a real `assessImpact` span landed in Langfuse with provider, model, token
  counts and 3.17 s latency, read back through Langfuse's public API.
- [x] Golden dataset 4 → 87 cases across 10 clinical categories, with the labeling rubric and
  the synthetic-NDC caveat documented in the file. `pnpm eval` runs a deterministic 12-case
  stride; `pnpm eval:full` runs all 87 (~12 min, ~500 local model calls).
- [x] **Measured eval results (mistral 7B local, temperature 0, best-of-3 per case):**
  75/89 and 71/89 checks passed on two full runs — i.e. **80-84%, and the same corpus varies
  by ~4 points between identical runs**, which is exactly why the eval suite is not a hard
  gate. Failures cluster in three honest weaknesses, not random noise:
  1. **No-equivalent drugs** (methotrexate PF, vincristine, Rho(D), asparaginase, isoniazid,
     phytonadione, thiamine, sterile water) — the model invents a substitute where a
     pharmacist would say there is none. This is the under-escalation direction and the most
     important open weakness.
  2. **Resolved shortages** (saline, withdrawn ranitidine) — over-escalates something already
     resolved.
  3. **Severity floors** on a few critical-care items (epinephrine, succinylcholine).
  A Gemini-class model is expected to do better on all three; that comparison is the blocked
  item below.
- [ ] Gemini-vs-Ollama comparison table (blocked on `GEMINI_API_KEY`, see `PHASE5-TODO.md`)

## Phase 3 — Memory + shadow (weeks 4–6)

**Status:** in progress — PR #3 open.

Target deliverable: versioned protocol store + provenance; exception loop; shadow ledger +
replay corpus + agreement dashboard; promotion gates.

- [x] Versioned protocol store (`protocols` / `protocol_versions`): immutable versions
  numbered per protocol, approval supersedes the previous approved version in one
  transaction, provenance (source case, author, approver, rationale) on every row
- [x] Protocol memory in the case workflow: an approved protocol is reused instead of paying
  for a research call; approved agent drafts and pharmacist edits are written back
- [x] Exception loop: exception cases park and wait for a pharmacist; the resolution becomes
  an approved protocol version and the case continues from where it parked
- [x] Recurring shortages can reopen a case (dedupe now targets *running* cases), plus the
  audit idempotency key gains `run_id` so a second run doesn't collide with the first
- [x] Shadow ledger + replay corpus (derived from the golden dataset) + agreement scoring +
  per-drug-class promotion gates (shadow → suggest → auto-draft, stricter severity bar)
- [x] Console: `/protocols` (version history + provenance) and `/shadow` (per-class
  agreement, promotion stage, blockers, recent-run triage)
- [x] Verified live against real Temporal + Postgres + Ollama: agent draft approved → v1
  approved → case closed → recurrence reused v1 from memory with no duplicate version; an
  immune-globulin case parked as `no-therapeutic-equivalent` → pharmacist resolution → v1
  authored by the pharmacist → case continued to monitoring
- [x] Shadow replay of 24 corpus entries: injectable 74% mean agreement / 63% severity match
  (19 runs), oncology 80% / 100% (5 runs) — both correctly held at the `shadow` stage by the
  promotion gates
- [ ] Extract `shadow-ledger` as a standalone npm library (PROJECT_PLAN §12 artifact 5 —
  Phase 5 packaging work)

## Phase 4 — Product (weeks 6–8)

**Status:** not started

---

## Merged-PR log

<!-- append one line per merged PR: ✅ <PR title> — <what it proved> -->
✅ Phase 2 — Intelligence: agents, confidence routing, eval gate ([#2](https://github.com/tomnguyen103/stopgap/pull/2)) — Zod-validated impact/alternatives agents replacing Phase 1 mocks, confidence routing to the exception queue, prompt-injection defense, golden dataset + `pnpm eval` running live on Ollama. CodeRabbit clean after 3 rounds (escaped record delimiter, blank-alternative normalization, stricter injection assertions in the last round).
✅ Phase 1 — Spine: durable case engine, provider routing, live feeds ([#1](https://github.com/tomnguyen103/stopgap/pull/1)) — Temporal + Postgres + live openFDA/ASHP polling, Gemini/Ollama provider registry with failover, Next.js 15 console, `pollFeedsWorkflow` auto-opening cases (57 real cases opened live in verification), weekly-tick monitoring loop, retry-safe hash-chained audit log. 23/23 tests green, `pnpm gate` clean, CodeRabbit clean after 4 rounds.
