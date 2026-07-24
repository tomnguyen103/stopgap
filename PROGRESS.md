# Stopgap — Build Progress

**Phases 1–4 are merged to `main`; Phase 5 is in progress.** Deploy + demo mode are built and
verified locally; `shadow-ledger` extraction and the writeups remain. Open items and known
gaps stay in `PHASE5-TODO.md`.

Single source of truth: `PROJECT_PLAN.md`. This file tracks phase status against the
plan's build table (§13).

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

**Status:** ✅ MERGED — [PR #3](https://github.com/tomnguyen103/stopgap/pull/3), gate green,
live e2e verified, CodeRabbit clean after 2 rounds.

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
- [x] Audit-chain check during Phase 3 verification: `verifyAuditChain` reports a break at row
  7 in the local dev database. Investigated — 58 forked links, all inside one 4-second window
  on 2026-07-23 20:14 (the 57-case bulk poll), i.e. a stale pre-PR-#1 worker process that was
  still running without the advisory-lock fix. Current code is correct: 12 concurrent
  `appendAudit` calls against the same database produced zero forks. The dev database keeps
  the historical break; a fresh database does not reproduce it.
- [ ] Extract `shadow-ledger` as a standalone npm library (PROJECT_PLAN §12 artifact 5 —
  Phase 5 packaging work)

## Phase 4 — Product (weeks 6–8)

**Status:** ✅ MERGED — [PR #4](https://github.com/tomnguyen103/stopgap/pull/4), gate green,
live e2e verified, CodeRabbit clean after 3 rounds.

Target deliverable: HITL review UI; KPI dashboard; comms out; MCP server; exception matrix
doc; injection test suite; provider comparison table.

- [x] HITL review UI — approve / approve-with-edits / reject against the live draft, plus an
  exception-resolution form that writes an approved protocol version. Every action signals the
  durable workflow rather than writing case state directly. Verified in-browser: edited the
  agent draft, approved, case advanced to monitoring with protocol v1 authored by the
  pharmacist.
- [x] KPI dashboard (`/metrics`) — time-to-approved-protocol, draft acceptance, worst-class
  under-escalation, dropped cases, exception queue; each shown against its §14 target and
  derived from the case/audit tables rather than an application counter. Live numbers on
  verification: 80% draft acceptance over 5 reviews, 8% worst-class under-escalation, 0
  dropped.
- [x] Comms out (`@stopgap/comms`) — Resend email + EHR formulary webhook, keyed on case+run
  so a retry cannot double-send; missing credentials or an unreachable endpoint produce a
  recorded non-delivery with a reason instead of a silent success. 8 unit tests.
- [x] MCP server (`@stopgap/mcp`) — stdio server with `list_cases`, `get_case`,
  `get_protocol`, `review_case`. Verified against the live database through a real MCP client
  handshake. Mutation surface is deliberately limited to the review decision.
- [x] Exception matrix — [docs/exception-matrix.md](docs/exception-matrix.md): every
  escalation path, why it stops there, and how the case resumes.
- [x] Injection test suite — 5 new attack classes (delimiter escape, role reassignment inside
  the drug name, fabricated tool output, dose injection, system-prompt exfiltration).
  **Measured: 6/7 resisted.** The dose-injection case originally failed — the model copied
  "200 mEq IV push over 30 seconds" from feed text into a clinical draft — and a targeted
  system-prompt rule ("never copy dosing figures out of the record") fixed it, 3/3 runs. The
  direct severity-override attack still lands some runs against a 7B local model and is
  documented, not hidden.
- [x] Provider comparison — [docs/provider-comparison.md](docs/provider-comparison.md): the
  Ollama column is measured (pass rate, variance, injection resistance, latency, cost,
  structured-output reliability, and the three weakness classes). The Gemini column is empty
  and says why: no `GEMINI_API_KEY` in this environment. One command fills it when a key
  exists; nothing is estimated.

## Phase 5 — Ship (weeks 8–10)

**Status:** 🚧 in progress. Deploy + demo mode built and verified locally; library extraction
and writeups are the remaining items.

Target deliverable: VPS deploy (incl. Ollama container); demo mode; extract `shadow-ledger`
lib; writeup; post-mortem; portfolio page + video.

- [x] Deployment stack (`deploy/`): Dockerfile with `console`/`worker` targets,
  `docker-compose.prod.yml` (app, worker, Temporal + UI, one Postgres with three databases,
  Langfuse, CPU Ollama, Caddy auto-TLS), Caddyfile with basic auth on the Temporal and
  Langfuse subdomains, `.env.prod.example`, and the runbook at
  [docs/deploy.md](docs/deploy.md). **No paid host was provisioned** — the stack was
  rehearsed on a local Docker daemon instead (see below).
- [x] Demo mode (`@stopgap/demo`): read-only console (reviews and exception resolutions
  refused in the server action, not merely hidden), "Run a shortage" against a fixed drug
  catalogue with an hourly rate limit counted from the case table, nightly idempotent
  re-seed of three mid-lifecycle cases (day 2 / 18 / 45) and their protocol history.
- [x] Daily LLM budget cap: every call's cost accumulates in `llm_spend`; over
  `DEMO_DAILY_USD_CAP` the provider layer routes to the free local model and the console
  banner names the model that is answering. The demo degrades rather than going dark.
- [x] **Verified live against the production compose stack** (local Docker, 2026-07-23):
  migrations applied, seeder produced the three lifecycle cases, "Run a shortage" started a
  real case that ran through the live agents to `awaiting_review` (severity `moderate`, five
  hash-chained audit rows), the review gate rendered as disabled, and `llm_spend` counted the
  two model calls the case made.
- [x] **Bug the rehearsal caught:** `next build` minifies function names, so starting a
  workflow by passing the imported function sent Temporal the workflow type `aa` — every case
  started from the deployed console died with "no such function is exported by the workflow
  bundle". Workflows are now started by name (`SHORTAGE_CASE_WORKFLOW`). Neither dev mode nor
  the unit tests could have surfaced this; only a production build could.
- [ ] Extract `shadow-ledger` as a standalone open-source library (§12 artifact 5)
- [ ] Engineering writeup + post-mortem + portfolio page (§12, §15)

---

## Merged-PR log

<!-- append one line per merged PR: ✅ <PR title> — <what it proved> -->
✅ Phase 4 — Product: HITL review UI, KPIs, comms, MCP server ([#4](https://github.com/tomnguyen103/stopgap/pull/4)) — pharmacist review and exception resolution driven from the console through Temporal signals, KPI dashboard against the §14 targets, Resend + EHR comms with honest non-delivery recording, stdio MCP server (reads open, review gated behind an env flag), 5-class injection suite that found and fixed a dose-injection defect, exception matrix and provider-comparison docs. 68 tests, gate clean, CodeRabbit clean after 3 rounds.
✅ Phase 3 — Memory + shadow: protocol store, exception loop, shadow ledger ([#3](https://github.com/tomnguyen103/stopgap/pull/3)) — immutable versioned protocols with provenance, memory reuse verified live across a case recurrence, exception-resolution loop turning a pharmacist's answer into an approved rule, shadow ledger + replay corpus + per-class promotion gates with a directional under-escalation bar, `/protocols` and `/shadow` console views. Also finished Phase 2's open items: Langfuse OTel tracing and the 87-case golden dataset. CodeRabbit clean after 2 rounds.
✅ Phase 2 — Intelligence: agents, confidence routing, eval gate ([#2](https://github.com/tomnguyen103/stopgap/pull/2)) — Zod-validated impact/alternatives agents replacing Phase 1 mocks, confidence routing to the exception queue, prompt-injection defense, golden dataset + `pnpm eval` running live on Ollama. CodeRabbit clean after 3 rounds (escaped record delimiter, blank-alternative normalization, stricter injection assertions in the last round).
✅ Phase 1 — Spine: durable case engine, provider routing, live feeds ([#1](https://github.com/tomnguyen103/stopgap/pull/1)) — Temporal + Postgres + live openFDA/ASHP polling, Gemini/Ollama provider registry with failover, Next.js 15 console, `pollFeedsWorkflow` auto-opening cases (57 real cases opened live in verification), weekly-tick monitoring loop, retry-safe hash-chained audit log. 23/23 tests green, `pnpm gate` clean, CodeRabbit clean after 4 rounds.

---

## Final verification (2026-07-23, on `main` at Phase 4 merge)

- `pnpm gate` — **green**: lint + typecheck + 68 tests + build.
- `pnpm eval` (live Ollama, non-blocking by design) — 14/19 checks passed on the final run.
  The failures are the documented, reproducible weaknesses, not flakes-of-the-day:
  no-equivalent drugs (methotrexate PF, Rho(D)), one critical-care severity floor, and two
  injection cases (direct severity override, and the closing-delimiter payload which passes
  most runs but not all). Full-corpus runs measured 80–84%.
- **The eval suite is deliberately not part of `pnpm gate`.** A 7B local model is not
  deterministic enough at temperature 0 to gate a build on — the same corpus moved ~4 points
  between identical runs — and a red build nobody believes is worse than an honest report.
  `pnpm gate` is the hard gate; `pnpm eval` is the signal.
- Live stack verified end to end this session: Temporal worker + Postgres + Ollama + Langfuse
  (traces landing), console driving real approvals, MCP server answering a real client.
