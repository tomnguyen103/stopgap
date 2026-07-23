# Portfolio Project — Research, Decision & MVP Plan
**Date:** 2026-07-23 · **Target:** Automation & AI Agent Engineer / AI-led workflow automation roles · **Status:** PLANNING ONLY — nothing built

---

## Phase 0 — Existing project review (summary)

`C:\Users\huuth\Desktop\notebooklm\Daily-Project` is **not one project** — it is **46 independent daily demos** (Jul 9–23, 2026), built by an autopilot pipeline. Each is a complete, tested v1 (~600–6,000 LOC; TS/Python/Go; strict typing; real test suites; spec/plan/grade docs), all offline-deterministic, **none deployed, none with real integrations or users**.

Strongest seeds relevant to this plan:
- **`triage-md`** — clinical intake triage: PHI de-identification at ingest, refuse-diagnosis guardrail, deterministic red-flag over-triage net, hash-chained audit log, clinician HITL review queue, eval harness (red-flag recall 1.0)
- **`opspilot`** — agent orchestrator over MCP tools with approval gate
- **`unwind`** — saga/compensation rollback for agent tool calls, retry budgets, DLQ
- **`vaultrag`** — retrieval-time ACL / multi-tenant secure RAG
- **`lucent`** — OTel GenAI observability + eval sidecar
- **`warden`** — OAuth 2.1 resource server for MCP

Checklist distance (portfolio as a whole): agents ✅, evals ✅, robust business logic ✅, guardrails ✅ · systems integration ✖ (all mocked), real end-to-end process automation ✖, deployment ✖, users/metrics ✖, business-impact framing ✖ (synthetic only).

Verdict on codebase soundness: high — small, typed, tested, injectable interfaces. Raw material is unusually good; the uniform gap is the **last mile**: real integrations, deployment, users.

## Phase 1 — Market & trend research (key findings)

### Healthcare (primary domain) — the pain is quantified and current
- **Prior authorization:** ~40 PAs/physician/week, ~13 hrs/wk staff+physician time (AMA 2025 survey, publ. May 2026); $11 manual vs $2–6 electronic per transaction (CAQH); denial rates at 5-year high; 95% of physicians say PA delays care.
- **Referrals:** ~35%+ of inbound hospital documents are still **faxes**; **46% of faxed referrals never get scheduled**; 38% never close the loop (MGMA 2025); leakage ≈ $150B/yr.
- **Claims/denials:** $25.7B/yr adjudication cost (+23% YoY); ~15% initial denial rate; **~70% of denials overturned on appeal** (i.e., payer's first answer often wrong — automation must handle appeals, not just submission); ~24% of denials trace to registration/eligibility errors.
- **Intake:** ~$125K/yr manual intake labor per practice; 31% paper transcription error rate vs ~1% electronic.
- **Regulatory forcing function — CMS-0057-F:** PA turnaround mandates in force **Jan 1, 2026**; first public PA metrics **Mar 31, 2026**; **Jan 1, 2027: payers must ship FHIR Prior Auth APIs** (Da Vinci CRD + DTR + PAS). Mid-2026 = payers scrambling, providers have almost no tooling to consume these APIs. HL7 publishes free CRD/DTR/PAS reference implementations + ONC Inferno PAS test kit — a solo dev can run the full ePA loop locally.
- **Funded proof of market:** Tennr $101M Series C ($605M val — fax referral automation), Cohere Health $90M C (prior auth), Latent $80M A ($600M val), Anterior $40M, Infinitus $51.5M C, SmarterDx $50M B, Assort $120M C, Abridge $300M E.
- **FDA/HIPAA green light:** FDA's revised CDS guidance (final Jan 6, 2026) puts admin/PA/claims/referral workflow software cleanly outside device territory; Synthea synthetic FHIR data eliminates PHI exposure.
- **Solo-demoable:** fax/PDF referral intake, Da Vinci PA loop against public reference servers, eligibility reconciliation, denial/appeal drafting. Enterprise-locked (simulate, don't attempt): real clearinghouse connectivity, real payer IVR calls, deep production EHR access (Epic on FHIR sandbox is free and credible).

### Agentic automation landscape (core capability)
- What enterprises actually buy in 2026: **agents for judgment steps + deterministic workflow engine for orchestration + HITL approval gates** — the hybrid that displaced pure RPA (UiPath Maestro, AA Process Reasoning Engine, Agentforce ~$800M ARR). Gartner: >40% of agentic projects will be canceled by 2027 for weak ROI/controls — reliability engineering IS the differentiator.
- TS-stack winners: **LangGraph** (production standard), **Mastra** (TS-native, used by Replit/PayPal/Brex), **Claude Agent SDK**, Vercel AI SDK (UI edge only). Durable execution: **Temporal** ($5B val; OpenAI/Replit/Abridge/ADP run agents on it; official HITL patterns), Inngest, Trigger.dev, **Hatchet** (Postgres-native).
- MCP: Linux Foundation (AAIF) standard since Dec 2025; ~10k registry servers; OAuth 2.1 + PKCE mandatory for exposed servers; MCP gateway = dominant enterprise pattern.
- Reliability canon: trajectory-level evals with CI regression gates; idempotency keys + claim-then-execute for side-effecting tools; checkpoint per step; schema-validated structured outputs; iteration caps; OTel GenAI conventions → Langfuse (self-hosted on Postgres = extra signal). Sobering stat: ~48% of orgs with production agents skip offline evals — a portfolio that has them stands out.

### Hiring market (13 postings collected — Cresta, Included Health, Onit, n8n, Firstup, Tennr, Cohere Health, Natera, Commure, Actian, Entrata, Binance, Jobgether)
Near-universal asks: production agents, RAG, tool calling, API/webhook integration, relational DB, "scalable/reliable/production-ready," partnering with ops teams. TypeScript in ~⅔ of postings.
**Rarely-demonstrated differentiators (ranked by frequency × portfolio rarity):**
1. Eval discipline — golden datasets, regression-gated CI (Onit's 90-day goal verbatim: "offline eval suite with regression gates")
2. HITL approval flows with audit trail (physician sign-off is a hard requirement in health-tech)
3. Observability/tracing — OTel + LLM traces, retries, DLQ, cost/latency dashboards
4. Durable execution (Temporal named explicitly)
5. **Workflow-redesign memo** — written before/after process analysis with exception matrix ("redesign, don't automate legacy")
6. Measured business impact (hours saved, error rate vs human baseline)
7. MCP server authoring (correlated with 15–25% pay premium per KORE1)
8. PHI/safety layer — redaction, injection defense, sandboxed tools, least privilege
9. Exception-routing table as first-class artifact
Health-tech hirers (Tennr, Cohere Health, Included Health, Commure, Natera) want exactly: document/referral automation, prior auth, PHI-safe patterns, HITL, FHIR depth, Playwright-style legacy RPA.

### Phase 1b — Prior work (tomnguyen.me + github.com/tomnguyen103)
Already demonstrated: cited/agentic RAG ×2, eval harnesses with CI gates, MCP server, BullMQ/Trigger.dev queues, voice (Stream), mobile (Expo), real-time collab, classic ML with champion/challenger, JWT/RBAC, NL-to-SQL guardrails, audit logging, Prometheus/Grafana, PostHog. Day job = clinical portal + medical billing + HL7/SFTP at Texas Regional Physicians / Memorial MRI.
Use-case domains covered: PKM, finance analytics, marketing, dev tooling, edtech, algorithms. **No public healthcare project exists** despite healthcare being his professional domain.
Portfolio gaps (align exactly with hiring gaps): real HITL approval gates (only simulated/planned), email/webhook/calendar integration, end-to-end business process automation, workflow-redesign framing, retry/DLQ semantics, business-impact numbers.

### NotebookLM notes signal
Vault's own recommendation engine flags "full-stack AI product" as the open portfolio slot; healthcare appears once (`triage-md`) and is called out as ground not yet covered with a real UI/product. Deep recurring study themes: MCP (incl. July 28 spec RC), agent guardrails, evals, AG-UI streaming. Everything needed for a healthcare agentic product already exists as patterns in the vault.

---

## Phase 2 — Decision: GREENFIELD (Path B), harvesting Daily-Project components

**Decision: greenfield.** Reasoning against the four extend-criteria:
- (a) *Anchors a real business process?* No single Daily-Project does. `triage-md` is the closest but covers intake triage, not a full repetitive business process with integrations.
- (b) *Can grow to full checklist?* No single project can; the checklist coverage lives scattered across 5–6 separate codebases in 3 languages.
- (c) *Domain priority?* Only `triage-md` touches healthcare.
- (d) *Extending beats restarting?* At the component level yes — but there is no product-shaped codebase to extend. "Extending" 46 demos means composing a new product anyway.

So Path B — with a twist: the greenfield project deliberately **ports proven patterns** from `triage-md` (PHI de-id, refuse/abstain state machine, hash-chained audit), `opspilot` (HITL gate), `unwind` (saga/rollback, retry budgets, DLQ), `vaultrag` (ACL retrieval), `lucent` (OTel GenAI), and Second Brain (cited RAG + eval CI). New use case, proven DNA.

**What would flip it:** if "extend" is read as "compose the triage-md cluster into one product," the plans converge — the practical work is identical. The label matters less than the outcome: one deployed product, not a 47th demo.

---

## Path B1 — Ideation (3 ideas)

### Idea 1 — Referral-to-Authorization Ops Pipeline (healthcare) ⭐ SELECTED
**Working name:** *Clearway* — "the referral clears the way before the patient arrives."

- **Trend grounding:** Tennr ($605M) proves the fax-referral wedge; Cohere/Latent/Anterior prove the PA wedge; CMS-0057-F makes Jan 2027 the FHIR PA API deadline — building against Da Vinci CRD/DTR/PAS in mid-2026 is riding the single most timely rail in health-tech. AMA: 13 hrs/wk PA burden; 46% of faxed referrals never scheduled.
- **Business process automated:** specialty-practice inbound referral → intake → eligibility check → prior-auth determination + submission → scheduling proposal — today a fax-and-phone swamp spanning 3–5 staff roles.
- **Measurable improvement targets:** referral-to-scheduled turnaround days → hours; % referrals lost (46% baseline → near 0 in demo); PA assembly time (~45 min manual → minutes + one human review); denial-precursor errors caught pre-submission (24% of denials are registration/eligibility errors).
- **Workflow redesign angle:** manual process is sequential and human-gated at every step. Redesigned process: machine does classification/extraction/validation/evidence-assembly in parallel the moment the fax arrives; humans only touch **exceptions and approvals** — a review queue with full context instead of retyping from a fax. Before/after memo is a first-class deliverable. Key exceptions handled explicitly: multi-patient faxes, missing chart notes/signatures, wrong/inactive 271 eligibility responses (ID-format mismatches, QMB quirks), payer-specific PA criteria that change quarterly, PA denial → appeal path (70% of denials overturn), duplicate referrals, expired insurance mid-process.
- **Checklist coverage:** every item — agents (multi-step, tool-using, judgment steps) ✅ · systems integration (email + fax-PDF ingest, FHIR/Medplum, mock payer APIs, webhooks, queues, MCP) ✅ · RPA-style E2E automation ✅ · workflow redesign ✅ · robust exception logic ✅ · scalable backend service ✅ · production-readiness (retries, HITL gates, audit, evals, observability) ✅ · product mindset (instrumented KPIs, feedback loop) ✅ · business impact (hours/turnaround dashboard) ✅.
- **Prior-work extension:** RAG+evals from Second Brain, queues from Social Copilot, guardrails/audit from Financial Platform, `triage-md` safety machinery. New use case: healthcare back-office ops — absent from public portfolio, present in day-job resume (HL7, clinical portal, billing) → coherent hiring story.
- **Problem/user:** specialty-practice referral coordinators + PA staff drowning in faxes and payer portals.
- **Stack:** Next.js 15 + TypeScript (UI/API) · PostgreSQL · Temporal (TS SDK) for durable workflows + HITL signals · LangGraph.js (or Claude Agent SDK) for agent judgment steps · Medplum (FHIR store) · Synthea synthetic patients · HL7 Da Vinci CRD/DTR/PAS reference implementations as mock payer · Langfuse self-hosted (evals + tracing, OTel GenAI) · MCP server exposing pipeline tools · Docker Compose, deployed demo.
- **Regulatory scope:** 100% synthetic data (Synthea + self-generated fake faxes); provider-side admin workflow; non-diagnostic (agent never makes clinical judgments — it assembles, validates, drafts; humans approve); outside FDA device territory per Jan 2026 CDS guidance; HIPAA posture documented as "architected for PHI (de-id at ingest, least privilege, audit chain) but zero real PHI processed."
- **Wow factor:** hits all 9 rarely-demonstrated hiring differentiators in one system; speaks Tennr's and Cohere Health's exact language; CMS-0057-F timing shows market awareness.
- **Scope:** ~6–10 weeks manual-equivalent; very feasible AI-assisted.

### Idea 2 — Claims Denial & Appeal Copilot (healthcare)
- **Grounding:** $25.7B adjudication waste, 15% denial rate, 70% overturn rate, $25–181 rework per claim; SmarterDx/RevCycle GenAI adoption at 80% of health systems.
- **Process:** 835/837 + CARC/RARC denial codes → triage by root cause → RAG over payer policies → draft appeal letters citing chart evidence → HITL approval → track outcomes.
- **Redesign:** from worklist-grinding to exception-classified queues with pre-drafted appeals; edge cases: timely-filing deadlines, payer-specific appeal formats, partial denials, COB.
- **Coverage:** strong on agents/evals/HITL/impact; weaker on live multi-system integration (mostly file-format ingestion); narrower demo surface than Idea 1; overlaps Financial Platform's "analyze financial documents" feel.
- **Stack:** same base; X12 835/837 parsers; synthetic claims corpus.
- **Why not selected:** less visually demonstrable end-to-end story; no forcing-function deadline narrative; weaker systems-integration showcase.

### Idea 3 — AP Invoice Processing Agent (business-ops)
- **Grounding:** classic RPA displacement target; postings (n8n, Firstup) name finance-ops automation explicitly.
- **Process:** email inbox ingestion → invoice extraction → 3-way match (PO/receipt/invoice) against Postgres → exception routing → approval gate → payment-file export, with retries/DLQ and per-invoice cost metrics.
- **Coverage:** excellent on RPA/HITL/exceptions/impact; generic domain — hundreds of comparable portfolio projects; zero healthcare signal; doesn't leverage domain expertise.
- **Why not selected:** commodity use case; healthcare idea dominates on differentiation and employer targeting.

(No consumer idea — no exceptional signal found; consumer explicitly tertiary.)

## Path B2 — Selection: Idea 1 (Clearway)

Justification against the role profiles:
- Posting 1 (RPA + integration + agents + agentic AI, production-ready): Clearway is literally an RPA-replacement of a fax-driven process, with agents at judgment steps, deterministic Temporal orchestration, and real integration surface.
- Posting 2 (redesign workflows, exceptions/edge cases, TypeScript + relational DB, product mindset, measurable impact): the redesign memo, exception-routing matrix, TS+Postgres stack, KPI dashboard, and before/after metrics map one-to-one.
- Hiring market: health-tech is the hottest automation hiring segment found (Tennr ~36 open roles, Cohere Health, Included Health $175–240k for FHIR-deep engineers); Clearway is a direct work-sample for those companies AND a general-purpose agentic-automation showcase for everyone else.
- Beats Ideas 2/3 decisively on: integration breadth, timeliness (CMS-0057-F), demo-ability, domain-résumé coherence (his day job is literally clinical portals + HL7 + billing).

---

## Phase 4 — MVP Plan: Clearway

### Core MVP feature set
1. **Inbound intake:** email inbox (attachment ingestion) + "fax" drop (PDF upload/webhook) → document classification (referral / records / PA response / junk) → extraction (demographics, insurance, diagnosis, requested service, referring provider) with confidence scores → validation against FHIR store.
2. **Eligibility check:** simulated 270/271 service with realistic failure modes (inactive-coverage false negatives, ID-format mismatches) → agent reconciliation → exception queue when unresolvable.
3. **PA determination & submission:** CRD hook ("is PA required for this CPT+ICD+plan?") → DTR questionnaire completion drawing evidence from the Synthea chart → medical-necessity draft with citations → **HITL approval gate** → PAS submission to mock payer → status polling → approve/deny/pend outcomes → appeal-draft path on denial.
4. **Scheduling proposal:** on clearance, propose appointment slots (calendar integration), notify referring practice (outbound email).
5. **Ops console (Next.js):** live pipeline board (every referral's state machine position), exception queues by class, HITL review UI (side-by-side source document vs extracted data vs drafted PA, one-click approve/edit/reject), KPI dashboard.
6. **Mock payer service:** standalone CRD/DTR/PAS implementation with configurable payer-specific rules — doubles as a potential open-source contribution (real 2026 tooling gap).

### Architecture overview
```
Email/PDF in ──▶ Ingest API ──▶ Temporal workflow (one per referral, durable, days-long)
                                   ├─ Activity: classify/extract (LLM, structured output, confidence)
                                   ├─ Activity: validate vs Medplum FHIR (deterministic)
                                   ├─ Activity: eligibility 270/271 (mock svc, retry+idempotency)
                                   ├─ Signal: HITL approval (workflow paused, resumable)
                                   ├─ Activity: CRD → DTR → PAS (mock payer, saga w/ compensation)
                                   └─ Activity: schedule + notify (idempotency keys)
Next.js console ◀── Postgres (app state, audit chain, metrics) ◀── workflow events
Langfuse (self-hosted, Postgres) ◀── OTel GenAI traces from every LLM step
MCP server ──▶ exposes pipeline tools (lookup referral, approve, query status) to any MCP client
```
Agent pattern: **deterministic Temporal state machine owns the process; LLM agents own only judgment steps** (classification, extraction, evidence assembly, drafting) with schema-validated outputs, iteration caps, and confidence thresholds that route to humans. This is exactly the hybrid enterprises buy.

### Integration map
| System | How |
|---|---|
| Email (inbound referrals + outbound notifications) | IMAP/Gmail API ingest + SMTP/Resend out |
| Fax simulation | PDF upload endpoint + webhook receiver |
| FHIR store | Medplum (TS SDK, REST, subscriptions) |
| Synthetic patients | Synthea bundles loaded into Medplum |
| Mock payer | Own CRD/DTR/PAS service (FHIR R4), validated against HL7 reference implementations / Inferno PAS test kit |
| Eligibility | Own mock 270/271 service with edge-case corpus |
| Calendar | Google Calendar API (or internal slot model for MVP) |
| Queues/durability | Temporal (TS SDK, docker-compose; signals for HITL) |
| MCP | Own MCP server over pipeline tools (stdio for MVP; OAuth 2.1 documented for exposed mode) |
| LLM | Claude API primary; Ollama fallback for offline demo mode |
| Tracing/evals | Langfuse self-hosted + OTel GenAI conventions |
| Analytics | PostHog (console usage) + internal KPI tables |

### Enterprise-grade features
- **MVP:** RBAC (admin / reviewer / read-only via Clerk or Auth.js), hash-chained audit log (port from triage-md), Langfuse observability + cost/latency dashboard, structured logs with trace IDs.
- **Phase 2:** admin dashboard (payer-rule management, user management), SSO (SAML/OIDC stub), advanced alerting.
- **Later:** multi-tenancy (org-scoped RLS — pattern already proven in Second Brain), gold-carding analytics.

### Production-readiness plan (features, not afterthoughts)
- **Errors/retries:** Temporal retry policies per activity; idempotency keys on every side-effecting call (claim-then-execute); saga compensation on PA-submission failures (unwind pattern); DLQ + replay for poison documents.
- **HITL:** approval gates at (1) extracted-data confirmation when confidence < threshold, (2) PA submission always, (3) appeal submission always. Paused workflows survive restarts; audit records who approved what, when, and what the agent proposed vs what was sent.
- **Edge cases:** explicit exception-routing table (exception class → auto-retry / fallback / human queue / abandon) shipped as a documented artifact; test corpus includes multi-patient faxes, skewed scans, missing pages, wrong eligibility responses, mid-process insurance changes, duplicate referrals.
- **Guardrails:** schema-validated structured outputs everywhere; prompt-injection tests against document content (a fax that says "ignore previous instructions" must not steer the agent); PHI-pattern redaction at ingest (Safe Harbor 18-identifier pass, from triage-md backlog); least-privilege tool scopes; iteration caps.
- **Agent evals:** golden dataset of ~50–100 synthetic referral documents with labeled expected extractions/decisions; trajectory-level scoring (not just final output); regression gate in CI (PR fails if extraction F1 or routing accuracy drops); online monitoring of confidence-vs-human-override rate. Metrics: extraction field-level F1, classification accuracy, PA-completeness score, under-escalation rate (must be ~0), cost/latency per document.
- **Post-mortem:** publish one written failure post-mortem during the build (strongest operational-maturity signal per hiring research).

### Iteration plan
- Instrument from day one: per-referral cycle time, touch time per human, exception rate by class, agent-draft acceptance rate (% approved without edits), override reasons (captured in review UI), cost per document.
- Feedback loop: every human edit in the review UI becomes a labeled eval case (pattern proven in Second Brain); weekly eval re-run; exception classes with rising volume get dedicated handling.
- Public metrics page in the demo: before/after (manual baseline from published data vs pipeline actuals).

### Full tech list
TypeScript · Next.js 15 · Node 22 · PostgreSQL 16 · Temporal (TS SDK) · LangGraph.js or Claude Agent SDK (choose during build spike) · Medplum · Synthea · HL7 Da Vinci CRD/DTR/PAS (FHIR R4) · X12 270/271 (simplified) · Langfuse (self-hosted) · OpenTelemetry GenAI · MCP (TS SDK) · Claude API + Ollama fallback · Clerk/Auth.js · Zod · Drizzle or Prisma · Docker Compose · Vitest + Playwright · PostHog · deploy: VPS (docker-compose) or Railway/Fly for the app + demo mode with recorded traces.

### Compliance & data handling
- Zero real PHI ever: Synthea + hand-crafted fake documents only; demo disclaimer.
- Architecture documented as HIPAA-ready: de-id at ingest, encryption at rest/transit, least-privilege access, immutable audit chain, no PHI in LLM prompts beyond de-identified minimum, BAA-required stance for any real deployment.
- Non-diagnostic by construction: agent handles administrative determinations only; clinical-necessity language is drafted from chart evidence and always human-approved; refuse/abstain machine from triage-md governs anything ambiguous.
- FDA: admin workflow software, outside device definition (Jan 2026 CDS guidance) — stated in README.

### Build phases & milestones
1. **Week 1–2 — Spine:** Temporal + Postgres + Medplum + Synthea load; one referral flows end-to-end with mocked activities; ops console skeleton shows workflow state.
2. **Week 2–4 — Intelligence:** classification/extraction agents with structured outputs + confidence routing; golden dataset v1; Langfuse tracing; eval CI gate live.
3. **Week 4–6 — Payer loop:** mock CRD/DTR/PAS payer service; eligibility mock with edge cases; PA assembly agent; HITL approval gates + audit chain; saga/rollback.
4. **Week 6–8 — Product:** review UI polish; KPI dashboard; scheduling + email out; MCP server; exception-routing table doc; prompt-injection test suite.
5. **Week 8–10 — Ship:** deploy; demo mode (seeded scenarios incl. the messy ones); workflow-redesign memo (before/after with numbers); failure post-mortem; engineering writeup; portfolio page + 3-min demo video.

### Success metrics (business-process-tied)
- Referral-to-decision turnaround: days (manual baseline) → < 1 hr machine time + human review latency
- Human touch time per referral: ~45–60 min baseline → < 5 min (review-only)
- Lost referrals: 46% industry baseline → 0% (every document tracked to terminal state)
- Pre-submission error catch rate vs the 24%-of-denials registration-error class
- Agent-draft acceptance rate ≥ 80% without edits; under-escalation ≈ 0
- Eval gate: extraction F1 ≥ target, no CI regression merged

### Companion artifact — engineering writeup outline
**"Judgment in the loop: best practices for AI-led automation, learned building a healthcare referral pipeline"**
1. Why we redesigned the workflow instead of automating the fax (before/after, exception matrix)
2. Deterministic spine, probabilistic organs: Temporal + LLM division of labor
3. HITL as a state machine, not a checkbox (signals, resumability, audit)
4. Idempotency and sagas: what happens when the PA submission fails halfway
5. Evals as CI: golden documents, trajectory scoring, regression gates
6. Guardrails that earned their keep: injection-resistant document handling, confidence routing, refuse/abstain
7. Observability: OTel GenAI + Langfuse on a Postgres stack
8. What broke: a post-mortem
9. Costs, latency, and the metrics that mattered

---

## Tooling note
Research executed via 6 parallel background agents (codebase review, healthcare market, agentic landscape, hiring signals, portfolio audit, notes scan) with WebSearch/WebFetch. NotebookLM notes were read directly from disk (no NotebookLM skill needed). PM/architecture skill content applied inline; no build-phase skills invoked since this is planning only.

**STOP POINT: awaiting approval before any implementation.**
