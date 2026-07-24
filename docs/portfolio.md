# Portfolio page — Stopgap (copy for tomnguyen.me)

Source copy for the portfolio page (PROJECT_PLAN §12 artifact 1). Every number is measured;
nothing here is estimated. Where something was not measured, the copy says so — a portfolio
page with one invented metric makes every other claim on it worth checking.

---

## Stopgap

**Agentic platform for hospital drug-shortage response.** Multi-week durable workflows, an
agent layer that earns autonomy from measured agreement, and organizational memory that
writes itself from pharmacist decisions.

[GitHub](https://github.com/tomnguyen103/stopgap) ·
[Engineering writeup](writeup.md) · [Post-mortem](post-mortem.md) ·
[`shadow-ledger` library](../packages/shadow-ledger)

### The problem

A drug shortage arrives as an FDA feed entry and ends, weeks later, as a substitution protocol
the floor follows. In between, a pharmacist checks formulary impact, researches therapeutic
equivalents, drafts guidance, gets it approved, notifies the units, and monitors for months
until supply returns and the substitution is unwound. It is long-running, blocks on humans for
days at a time, is consequential enough that a wrong answer reaches patients, and repeats —
the same drug goes short again next year and nothing was retained the first time.

### Before → after

| | Manual | Stopgap |
|---|---|---|
| Detection | someone notices a feed post | 15-minute poll auto-opens a durable case |
| Impact + alternatives | hours of research per drug | agent draft in seconds, schema-validated |
| Approval | email threads | pharmacist gate as a workflow state, fully audited |
| Recurrence | research it again | approved protocol reused from memory |
| Evidence it worked | anecdote | hash-chained audit trail + KPI dashboard |

### Three patterns

**Deterministic spine, probabilistic organs.** Temporal owns the process — one durable
execution per case, surviving restarts, blocking for weeks on a human signal. The LLM is
called from activities and returns a Zod-validated object that is an *input* to a state
machine it cannot see. Hallucinations become wrong-but-valid transitions, never undefined
ones.

**Shadow mode.** The agent runs on real inputs, scored against a human baseline, producing
nothing anyone sees, until a drug class's measured agreement clears a bar. Autonomy is
per-class and earned. Extracted as the open-source
[`shadow-ledger`](../packages/shadow-ledger) library.

**Exceptions write the SOP.** When the agent cannot decide, the case parks for a pharmacist —
and their answer becomes an immutable, versioned protocol with provenance. The next case for
that drug reuses it instead of paying for research again.

### Measured

- **87-case golden dataset** across ten clinical categories: **80–84% pass** on a local 7B
  model (mistral, temperature 0), with the same corpus moving ~4 points between identical
  runs — which is why the eval suite reports rather than gates.
- **Injection suite: 6 of 7 attack classes resisted.** The one that landed — a dose-injection
  payload getting "200 mEq IV push over 30 seconds" copied into a clinical draft — was fixed
  and verified 3/3. A direct severity-override still lands on some runs against a 7B model,
  and is documented rather than hidden.
- **Shadow replay:** injectable 74% mean agreement / 63% severity match over 19 runs;
  oncology 80% / 100% over 5. Both correctly held at the `shadow` stage by the gates.
- **KPI dashboard, live:** 80% draft acceptance over 5 reviews, 8% worst-class
  under-escalation, 0 dropped cases. *Small samples — these are the real numbers from the
  verification session, not a projection.*
- **Live feeds:** one poll opened 57 real cases from openFDA with zero duplicates.
- **91 tests** in a deterministic local gate (lint + typecheck + test + build); live-model
  evals run separately, on purpose.

### Not claimed

- **No frontier-model comparison.** Gemini is implemented and routed to, but no API key
  existed in this environment, so the comparison table's Gemini column is empty rather than
  estimated.
- **No live deployment.** The single-VPS compose stack (app, worker, Temporal, Postgres,
  Langfuse, CPU Ollama, Caddy) is written and was rehearsed on a local Docker daemon; no host
  has been provisioned.
- **No auth layer.** Reviewer identity is recorded as an unverified claim. The demo is
  read-only because of it.

### Stack

TypeScript · Next.js 15 · Temporal · PostgreSQL + Drizzle · Vercel AI SDK (Gemini + Ollama,
health-check failover) · Zod · Langfuse + OpenTelemetry GenAI · MCP · Docker Compose · Caddy ·
Vitest

---

## Resume line

> Built a production-shaped agentic platform for hospital drug-shortage response — multi-week
> durable workflows (Temporal), shadow-mode evaluation against a human baseline, live
> FDA/RxNorm integrations, provider-portable LLM layer (Gemini + local Ollama) with measured
> trade-offs; open-sourced the shadow-evaluation harness.

## Demo video outline (3 min, §12 artifact 2)

Insurance against live-demo downtime; script, not yet recorded.

1. **0:00–0:25 — the problem.** A real openFDA shortage entry; what a pharmacist does with it.
2. **0:25–1:00 — a case opens itself.** Poll runs, case appears, Temporal UI shows the durable
   execution mid-flight.
3. **1:00–1:40 — the HITL gate.** The draft, the audit trail beneath it, approve-with-edits,
   the case advancing to monitoring.
4. **1:40–2:15 — memory.** Same drug recurs; the case reuses the approved protocol with no
   duplicate version. Then an exception case: no therapeutic equivalent, pharmacist resolves,
   the resolution becomes v1.
5. **2:15–2:45 — shadow + evals.** `/shadow` with the real per-class agreement numbers and why
   nothing is promoted yet; the eval failures shown, not skipped.
6. **2:45–3:00 — what is not built.** No auth, no frontier comparison, no live host.
