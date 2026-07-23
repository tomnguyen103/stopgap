# STOPGAP — Project Plan (APPROVED 2026-07-23)

**Hospital drug-shortage response platform.** AI agents turn the manual spreadsheet scramble into a monitored, durable, human-approved substitution pipeline.

**Path: B (greenfield).** Prior candidate (Clearway — referral/prior-auth) abandoned: space crowded (Tennr $101M, Cohere Health $90M, Anterior $40M, Latent $600M val, Basata, plus tutorials). Stopgap selected for double uniqueness: use case nobody has built × architecture patterns nobody demonstrates publicly.

**LLM decision (user-specified): Gemini 3.5 Flash Lite primary · Ollama for local dev, CI, and runtime fallback.** Agent layer = Vercel AI SDK (provider-agnostic, structured outputs). Model routing is a showcase feature.

---

## 1. Research foundation (key findings the build session needs)

### Problem, quantified
- Pharmacy staff spend ~20 hrs/wk managing shortages; 40+ hrs at 300+ bed hospitals (ASHP survey; Becker's)
- One heparin shortage = 421 active NDCs to evaluate (BD)
- 25% of pharmacies list shortage management as a top-3 unmet tech need
- State of the art = spreadsheets + email; pharmacists do therapeutic substitution manually (Pharmacy Times)

### Whitespace, verified by two independent research passes
- Existing vendors (LogicStream, Bluesight ShortageCheck, OrbitalRX, QuVa Shortage Navigator) sell *alert/intelligence feeds*, enterprise-priced for large systems
- Nobody automates the actual loop: detect → assess impact → find therapeutic alternative → draft substitution protocol → communicate → track to resolution
- Zero GitHub projects, zero funded startups on this workflow. GitHub has only API wrappers (rdrugshortages, display webapps)
- Free public data rails: FDA openFDA drug-shortages endpoint, ASHP shortage feed (ASHP-Software/drugShortagesDoc on GitHub), NLM RxNorm API

### Three architecture patterns with no public reference implementation (all land in this build)
1. **Shadow-mode deployment** — agent runs parallel to human baseline, scored, promotion-gated. Microsoft productized in Dynamics 365 July 2026; zero open-source implementations found
2. **Exception-to-SOP organizational memory** — human resolves exception once → agent drafts rule → approved rule enters versioned procedure store with provenance. Anchor paper: SAP Signavio, arXiv 2607.03228 (July 2026), proof-of-concept only, no implementation exists
3. **Long-horizon durable case agents** — cases living weeks/months with human checkpoints (Temporal TS SDK). Pattern documented (Temporal Code Exchange), but no public end-to-end weeks-long case lifecycle exists

### Hiring signal (13 postings analyzed)
Near-universal: production agents, tool calling, API/webhook integration, relational DB, TypeScript (~2/3 of postings). Rarely-demonstrated differentiators this project hits: eval discipline with CI regression gates, HITL approval flows with audit trail, observability/tracing, durable execution (Temporal named explicitly), workflow-redesign memo, measured business impact, MCP server authoring, safety/guardrail layer, exception-routing table as artifact.

### Runner-up ideas (if Stopgap ever stalls)
- Clinical trial site invoiceables reconciliation — 10–30% site revenue unbilled; zero PHI; no competitors
- P2P denial-review scheduling/prep — 14.4 physician hrs/wk; adjacent to crowded prior-auth space
- Interfacility transfer coordination (sending side) — only one 6-person unfunded entrant
- EU AI Act deployer-side FRIA workbench (non-health) — enforcement Aug 2026, only templates exist

---

## 2. The workflow (before → after)

**Before (manual):** pharmacist notices shortage via email → digs ASHP/FDA sites → checks EHR stock → researches alternatives → Word memo → emails P&T + providers → spreadsheet tracking → forgets follow-up at resolution.

**After (redesigned, not mirrored):**
1. Platform polls FDA + ASHP feeds → new shortage auto-opens a **case** (durable Temporal workflow, lives weeks–months)
2. Agent assesses impact: shortage NDCs × hospital formulary + inventory + usage velocity → severity score
3. Agent researches alternatives: RxNorm therapeutic classes, ASHP recommendations, substitute availability → drafts substitution protocol (dose conversions, ratio math flagged, allergy cross-reactivity warnings)
4. **Protocol memory check:** approved protocol exists for drug/class? Reuse + adapt. Else draft fresh
5. **HITL gate:** pharmacist reviews side-by-side (evidence, alternatives considered, draft) → approve / edit / reject
6. On approval: comms generated (provider email, EHR formulary-flag payload), inventory watch set
7. Case tracks until FDA marks resolved → reversion notice drafted → human approves → case closes
8. **Exception loop:** unhandleable cases route to exception queue; human resolution becomes candidate rule; approved rule enters versioned protocol store with provenance ("rule exists because of case #47")

**Exception matrix (shipped artifact):** no therapeutic equivalent (compounding/rationing → always human) · dose-ratio conversion on high-risk drugs (mandatory pharmacist math check) · conflicting ASHP vs FDA status · substitute goes short mid-case (cascade re-plan) · payer formulary mismatch · pediatric/renal variants · duplicate shortage records across feeds.

---

## 3. Signature subsystems (the differentiators)

### A. Shadow-mode harness
- Replay corpus of historical shortages (real past FDA/ASHP data), simulated pharmacist decisions as ground truth
- Shadow ledger (Postgres): proposed action, cost, latency, agreement score vs human baseline
- Disagreement triage UI; per-drug-class promotion gates: shadow → suggest → auto-draft
- Extracted as standalone open-source TS library (`shadow-ledger`) — second portfolio artifact

### B. Versioned protocol store (organizational memory)
- Postgres schema: protocols, versions, approval states, provenance links to originating cases
- Approved exception resolutions become rules; rules compose into living substitution protocols
- Full audit: who approved, agent-proposed vs shipped, why each rule exists

### C. Durable case engine
- One Temporal workflow per shortage; survives deploys; HITL via signals; time-skipped tests prove a 6-week case resumes
- Per-activity retry policies, idempotency keys on side-effecting calls, saga compensation, DLQ for poison feed records

---

## 4. Architecture

```
FDA openFDA + ASHP feeds ──poll──▶ Ingest ──▶ Temporal workflow per shortage case
                                                ├─ assess impact (formulary/inventory match — deterministic)
                                                ├─ research alternatives (agent via AI SDK → Gemini 3.5 Flash Lite, structured output)
                                                ├─ protocol memory lookup/draft (agent + versioned store)
                                                ├─ HITL signal (pharmacist approve/edit/reject)
                                                ├─ comms out (email, EHR payload — idempotent)
                                                └─ monitor until resolution → reversion → close
Next.js console ◀── Postgres (cases, shadow ledger, protocols, audit, metrics)
Langfuse ◀── OTel GenAI traces from every LLM step
MCP server ──▶ pipeline tools (query case, approve, protocol lookup)
```

- **Deterministic Temporal spine owns the process; LLM owns judgment only** — schema-validated outputs (Zod via AI SDK `generateObject`), confidence thresholds route to humans, iteration caps
- **Model routing layer:** provider registry — `gemini-3.5-flash-lite` (prod default) / Ollama local model (dev, CI, demo-budget-exceeded fallback). Runtime health check + automatic failover; per-provider cost + latency logged to Langfuse. Eval suite runs against BOTH providers — provider-comparison table in README (model-portability evidence)
- CI runs the entire agent test suite against Ollama — zero API cost, deterministic offline tests (temperature 0, pinned local model)

## 5. Integration map

| System | How | Real or mock |
|---|---|---|
| FDA openFDA drug shortages | REST polling | **REAL, live** |
| ASHP shortage feed | API/scrape | **REAL, live** |
| RxNorm (therapeutic classes) | NLM REST API | **REAL, live** |
| Gemini API (3.5 Flash Lite) | Vercel AI SDK google provider | Real |
| Ollama | AI SDK ollama provider, local + VPS container | Real (local) |
| Hospital formulary + inventory | Medplum FHIR + Synthea meds | Mock (realistic) |
| Provider comms | Resend/SMTP outbound | Real sends to demo inbox |
| EHR formulary flag | Webhook to mock endpoint | Mock |
| Pipeline tools | Own MCP server (TS SDK) | Real |
| Orchestration | Temporal TS SDK | Real |
| Tracing/evals | Langfuse self-hosted, OTel GenAI | Real |
| Usage analytics | PostHog | Real |

## 6. Enterprise features

- **MVP:** RBAC (admin / pharmacist / reviewer / read-only guest), hash-chained audit log, Langfuse observability + per-provider cost dashboard, structured logs with trace IDs
- **Phase 2:** admin dashboard (feed config, promotion-gate thresholds, model-routing config, users), alerting
- **Later:** multi-tenant (org-scoped RLS), SSO stub

## 7. Production-readiness plan

- Retries/idempotency/saga/DLQ per section 3C
- HITL gates: protocol approval always; comms always; low-confidence extraction
- Guardrails: schema-validated outputs everywhere; prompt-injection tests (poisoned feed record must not steer agent); refuse/abstain on clinical ambiguity; least-privilege tool scopes
- **Evals:** golden dataset ~60–100 historical shortage cases with labeled expected actions; trajectory-level scoring; CI regression gate on Ollama (free, offline) + nightly Gemini run; headline metric = shadow-mode agreement rate; under-escalation target ≈ 0; Gemini-vs-Ollama comparison table maintained
- One published failure post-mortem during build

## 8. Iteration plan

- Day-one instrumentation: time-to-protocol, human touch minutes, draft acceptance rate (% unedited), override reasons, exception volume by class, cost/latency per case per provider
- Every human edit → labeled eval case; weekly eval re-run; rising exception classes get dedicated rules
- Public before/after metrics page in demo

## 9. Compliance & data handling

- **Zero PHI ever** — drug-level data only (shortage feeds, formulary, inventory). No concern sending prompts to Gemini API (no patient data in any prompt); Ollama path documented as the fully-local option for a real hospital deployment
- Non-diagnostic: administrative pharmacy ops; pharmacist always approves; refuse/abstain governs ambiguity
- Outside FDA device scope (Jan 2026 CDS guidance) — stated in README
- Architecture documented HIPAA-ready (RBAC, audit chain, encryption) for credibility

## 10. Full stack

TypeScript · Next.js 15 · Node 22 · PostgreSQL 16 · Temporal TS SDK · Vercel AI SDK (agent layer + structured outputs) · Gemini 3.5 Flash Lite (prod) · Ollama (local dev, CI, fallback) · openFDA / ASHP / RxNorm APIs · Medplum + Synthea · Langfuse self-hosted · OpenTelemetry GenAI · MCP TS SDK · Zod · Drizzle · Auth.js · Resend · Docker Compose · Caddy · Vitest + Playwright · PostHog

## 11. Deployment & showcase

- **Hetzner VPS (~$9–15/mo), docker-compose:** app, worker, Temporal + UI, single Postgres (3 DBs: app/temporal/langfuse), Langfuse, Ollama container (small model, CPU), Caddy auto-TLS
- Subdomains: `stopgap.tomnguyen.me` (app) · `temporal.stopgap.tomnguyen.me` (basic-auth — visitors see real durable workflows) · `traces.stopgap.tomnguyen.me` (Langfuse read-only)
- **Demo design:** instant read-only guest mode (no signup) · nightly re-seed: 3 mid-lifecycle cases (day 2 / 18 / 45), populated shadow ledger, pending + approved protocols, exception queue · **"Run a shortage"** interactive scenario — Flash Lite pricing allows generous per-visitor limits; hard daily budget cap; over cap → auto-switch to VPS Ollama (banner notes local model); final fallback = demo video · live-feed panel with last-polled timestamp
- Ongoing cost: ~$10–15/mo VPS + ~$1–5/mo LLM

## 12. Portfolio attachment (5 artifacts)

1. Portfolio page on tomnguyen.me — problem stats, before/after diagram, three patterns, links
2. 3-min demo video (insurance for live-demo downtime)
3. GitHub repo — architecture diagram, ADRs, eval results incl. Gemini-vs-Ollama table, CI badge; pinned
4. Engineering writeup: **"Shadow mode, durable cases, and self-writing SOPs: three patterns for trustworthy AI agents"** — blog + dev.to crosspost
5. `shadow-ledger` npm library — extracted shadow-mode harness; second pinned repo

Resume line: "Built and deployed production agentic platform automating hospital drug-shortage response — multi-week durable workflows (Temporal), shadow-mode evaluation vs human baseline, live FDA/ASHP/RxNorm integrations, provider-portable LLM layer (Gemini + local Ollama); open-sourced shadow-evaluation library."

## 13. Build phases & milestones (~8–10 wks manual-equivalent)

| Phase | Weeks | Deliverable |
|---|---|---|
| 1. Spine | 1–2 | Temporal + Postgres + live feed polling; AI SDK provider routing (Gemini + Ollama) wired; one case end-to-end mocked; console skeleton |
| 2. Intelligence | 2–4 | Impact + alternatives agents, structured outputs, confidence routing; golden dataset v1; Langfuse; eval CI gate on Ollama |
| 3. Memory + shadow | 4–6 | Versioned protocol store + provenance; exception loop; shadow ledger + replay corpus + agreement dashboard; promotion gates |
| 4. Product | 6–8 | HITL review UI; KPI dashboard; comms out; MCP server; exception matrix doc; injection test suite; provider comparison table |
| 5. Ship | 8–10 | VPS deploy (incl. Ollama container); demo mode; extract shadow-ledger lib; writeup; post-mortem; portfolio page + video |

## 14. Success metrics (business-process-tied)

- Time-to-approved-protocol: days (manual) → < 1 hr machine + review latency
- Human touch per case: hours → < 10 min
- Draft acceptance ≥ 80% unedited; under-escalation ≈ 0
- Shadow-mode agreement ≥ target before any promotion
- 0 dropped cases (every shortage reaches terminal state)
- Eval CI gate: no regression merges; Gemini/Ollama parity tracked

## 15. Companion writeup outline

1. Why shortage response needed redesign, not automation
2. Deterministic spine, probabilistic organs (Temporal + agents)
3. Shadow mode: earning trust before autonomy
4. Exceptions that write the SOP: organizational memory with provenance
5. HITL as state machine (signals, resumability, audit)
6. Evals as CI: golden cases, trajectory scoring, free local regression gates with Ollama
7. Model portability: one agent layer, two providers, measured trade-offs
8. Guardrails that mattered: injection-resistant feeds, refuse/abstain, dose-math checks
9. What broke: post-mortem + costs/latency/metrics

---

## Notes for the build session
- Reusable patterns from `C:\Users\huuth\Desktop\notebooklm\Daily-Project`: `triage-md` (refuse/abstain machine, hash-chained audit), `opspilot` (HITL gate), `unwind` (saga/rollback, retry budgets, DLQ), `vaultrag` (ACL retrieval), `lucent` (OTel GenAI), `warden` (MCP OAuth)
- Git/PR workflow per global CLAUDE.md: disable GitHub Actions on first push, local gate = CI, CodeRabbit mandatory on PRs, codegraph init at start
- Project name slug: `stopgap`
