# Stopgap coverage ledger — 2026-08-01

This ledger reconciles the approved contract in `PROJECT_PLAN.md`, the Phase 5 closeout
items, the Phase 6 successor plan, the unified-platform specification and tickets, and the
console design plan. It uses source, tests, migrations, merged pull requests and current runtime
receipts as evidence. Status prose in older documents is treated as historical until it agrees
with those artifacts.

## Decision rules

- `Delivered` means the repository contains the implementation and its acceptance evidence.
- `Delivered — current receipt` means this session reran the relevant local proof.
- `Owner action` means the remaining action is an external publication, paid-hosting, account or
  production-credential decision. It is not repo-controllable work to invent here.
- `Intentional boundary` means the plan explicitly says not to build it, or a successor decision
  replaced the earlier wording. It is not a missing implementation.
- The untracked `docs/current-development-report-2026-08-01.md` is user-owned and was preserved.

## Current receipts

| Receipt | Result |
|---|---|
| Repository/GitHub | Base `5a4f9bb` was on `main` and `origin/main`; no open PRs; GitHub Actions permissions are disabled. Implementation work is on `fix/default-keycloak-csp`. |
| CodeGraph / Graphify | CodeGraph was already indexed and current. Graphify was refreshed locally for architecture cross-checking; generated output remains ignored. |
| Regression tests | CSP default-origin, self-contained Auth.js provider, zero-config principal, fail-closed middleware, docs-gate, malformed-issuer, anonymous visitor-quota and cookie-churn aggregate-bound regressions are covered by the final gate. |
| Local gate | Final post-change `pnpm gate` green: lint, typecheck, 75 test files/892 tests passed, and production build completed. Nonfatal existing warnings remain documented in the gate output. |
| Auth browser tier | `pnpm test:browser`: 5 passed after the default Keycloak CSP fix, with the console using the enforcing `stopgap_app` role. |
| Demo browser tier | `pnpm test:browser:demo`: 4 passed after zero-config principal hardening. |
| RLS / migrations | `pnpm test:rls` with `DATABASE_URL=stopgap_app` and maintenance URL `stopgap`: 9 files, 259 passed, 0 skipped. The superuser refusal remains an intentional guard. |
| UI runtime | Playwright captured 14 clean desktop/mobile role, case-detail and admin-credential surfaces at `C:\Users\huuth\.codex\visualizations\2026\08\01\019fbd9d-03c7-7321-905f-b70928348f07`; each captured page reported zero browser console errors/warnings and zero failed requests under the enforcing app role. A final exact-375px proof captured overview, queue, case detail, oversight, admin, API keys and users; every page reported viewport/client/document/body width 375 and zero browser errors/warnings/failed requests. |
| Eval / audit CLI | `pnpm eval`: 15/19 live Ollama checks passed; four failures were the known small-model weakness classes (three golden-dataset expectations and one delimiter-injection alternative assertion). `pnpm verify-audit` exited 1 at row 7 with `prev-hash-mismatch`; this is the documented 2026-07-23 stale-worker fork retained in the dev database, not a new code gap. |
| External state | No VPS, public DNS/TLS issuance, npm release, public-channel publication, Gemini key, ASHP credential, Resend key or Langfuse key was present/authorized. These remain honest external/configuration blockers. |

## A. `PROJECT_PLAN.md` contract

| ID | Non-superseded requirement | Status | Evidence / boundary |
|---|---|---|---|
| P-01 | Preserve the research foundation: shortage problem, whitespace, and the three differentiating patterns (shadow mode, exception-to-SOP memory, durable long-horizon cases). | Delivered | `PROJECT_PLAN.md` §1; `docs/writeup.md`; `docs/post-mortem.md`; `packages/shadow-ledger`; `packages/workflows`. |
| P-02 | Workflow: poll FDA/ASHP; assess impact; research alternatives; reuse protocol memory or draft; pharmacist HITL approve/edit/reject; emit comms and inventory watch; track feed resolution/reversion; route exceptions into versioned memory. | Delivered | `packages/ingest`, `packages/scorer`, `packages/agents`, `packages/workflows`, `apps/console/app/lib/actions.ts`; Phase 6 resolution and escalation work; live and unit/e2e receipts in `PROGRESS.md`. |
| P-03 | Shadow harness: replay corpus, durable ledger, agreement scoring, disagreement triage, per-class promotion gates, and standalone `shadow-ledger` artifact. | Delivered | `packages/shadow-ledger`; `packages/shadow`; `/shadow`; `packages/shadow-ledger/PUBLISHING.md`; 14-library-test receipt in `PROGRESS.md:224-230`. |
| P-04 | Versioned protocol store: immutable versions, provenance, approval state, exception resolutions becoming rules, and audit of authorship/approval. | Delivered | `packages/db/src/schema.ts`, workflow activities, `/protocols`, action tests and Phase 3 live receipt. |
| P-05 | Durable case engine: one Temporal workflow per shortage, HITL signals, retries, idempotency, saga/compensation posture, poison-record handling and time-skipped multi-week behavior. | Delivered | `packages/workflows/src/workflows.ts`, `activities.ts`, workflow tests, production-build workflow-name regression, Phase 5 rehearsal. |
| P-06 | Architecture: deterministic Temporal spine, schema-validated probabilistic agent layer, provider routing/failover, local Ollama gate, traces and MCP. | Delivered with provider caveats | `packages/providers`, `packages/agents`, `packages/observability`, `packages/mcp`, `vitest.eval*.config.ts`; live Gemini/ASHP/Langfuse credentials remain external blockers. |
| P-07 | Integration map: real FDA/openFDA, ASHP and RxNorm rails; Gemini/Ollama; realistic formulary/inventory inputs; honest comms; Temporal, Langfuse/OTel, MCP and analytics boundaries. | Delivered with honest non-configuration | `packages/ingest`, `packages/providers`, `packages/comms`, `packages/mcp`, deploy stack and `PHASE5-TODO.md:43-60`; absent credentials are recorded as unavailable, never faked. |
| P-08 | Enterprise MVP, Phase 2 admin/alerting, and later tenancy/SSO evolution. | Delivered by successor plans | RBAC/OIDC, admin, alerts, RLS and public API are in Phase 6 and unified tickets; older “Later: multi-tenant” wording is superseded by `PHASE6-PLAN.md` §6.5. |
| P-09 | Production readiness: retries/idempotency/saga/DLQ; HITL; schema and prompt-injection guardrails; golden evals; Gemini/Ollama comparison; failure post-mortem. | Delivered except credential-dependent comparison | `docs/exception-matrix.md`, compliance/injection suites, `docs/provider-comparison.md`, `docs/post-mortem.md`, `PROGRESS.md:82-95`; Gemini column is explicitly unmeasured. |
| P-10 | Instrumentation: business-process metrics, human-edit feedback, eval re-runs and public/demo before-after metrics. | Delivered where repo-controllable | `/metrics`, Prometheus/Grafana, `packages/observability`, shadow replay/eval corpus; public deployment metrics page is represented locally, while publication is owner action. |
| P-11 | Zero-PHI, administrative pharmacy boundary, pharmacist approval and documented HIPAA-ready posture. | Delivered | `packages/compliance`, `docs/exception-matrix.md`, `docs/unified-platform-spec.md` out-of-scope rules, injection/compliance tests; no patient-level feature was added. |
| P-12 | Deployment/showcase: production Compose/Caddy/Ollama/Langfuse shape, guest demo, nightly seed, Run-a-shortage, budget/fallback, live-feed freshness. | Repo implementation delivered; external/runtime proof remains | `deploy/`, `docs/deploy.md`, `@stopgap/demo`, `@stopgap/shadow` replay, `demo_runs` per-visitor plus aggregate quota, migrations `0023_lyrical_thor_girl.sql` and `0024_icy_barracuda.sql`, demo browser suite and local production-image rehearsal. Paid VPS/DNS/TLS, provider credentials and in-cluster Ollama fallback execution remain owner/runtime follow-up. |
| P-13 | Portfolio artifacts: portfolio copy, video, repo/architecture/eval evidence, writeup/post-mortem, extracted `shadow-ledger`. | Repo artifacts delivered; publication owner action | `docs/portfolio.md`, `docs/writeup.md`, `docs/post-mortem.md`, `packages/shadow-ledger`; public posting/video recording and npm/repo release remain external. |
| P-14 | Phase milestones 1–5 and successor hardening are completed through reviewed merged work. | Delivered | Merged-PR log in `PROGRESS.md`; Phase 6 PRs #6–#10; unified programme closeout #38; design passes #39/#41. |
| P-15 | Success metrics: time-to-approved protocol, human touch, draft acceptance, under-escalation, dropped cases, shadow agreement, eval non-regression and provider parity. | Measured/visible with honest gaps | `/metrics`, shadow dashboard, measured local eval and `docs/provider-comparison.md`; Gemini parity and external deployment metrics are `Unclear` until credentials/host exist. |
| P-16 | Companion writeup outline, including what broke, costs/latency/metrics, model portability and guardrails. | Delivered | `docs/writeup.md` and `docs/post-mortem.md` follow the stated outline and name unmeasured items rather than estimating them. |
| P-17 | Do not implement PROJECT_PLAN runner-up ideas; they are contingency research, not the Stopgap contract. | Intentional boundary | `PROJECT_PLAN.md:33-37`; no runner-up feature was promoted. |

## B. Phase 5 closeout

| Requirement | Status | Evidence / remaining boundary |
|---|---|---|
| Deployment stack, runbook and local rehearsal | Delivered locally | `deploy/`, `docs/deploy.md`, production-image rehearsal in `PROGRESS.md:183-223`. Paid VPS, DNS and TLS issuance are owner-controlled. |
| Demo mode, read-only mutation refusal, Run-a-shortage, durable per-visitor plus aggregate rate limits, nightly idempotent seed plus measured shadow replay, feed freshness, daily cap and local fallback | Delivered — current implementation | `packages/demo`, `packages/observability`, `packages/shadow`, `llm_spend`, `demo_runs`, `apps/console/app/lib/actions.ts`, migrations `0023_lyrical_thor_girl.sql` and `0024_icy_barracuda.sql`, `deploy/docker-compose.prod.yml`, demo browser 4/4. The in-cluster Ollama path remains a runtime proof item. |
| `shadow-ledger` extraction | Delivered | `packages/shadow-ledger`, adapter in `packages/shadow`, README, 14 tests and publishing instructions. npm/pinned-repo release is owner-controlled. |
| Writeup, post-mortem and portfolio copy | Delivered in repository | `docs/writeup.md`, `docs/post-mortem.md`, `docs/portfolio.md`; public cross-posts and video recording are owner-controlled. |
| Demo shadow-ledger rows | Delivered — measured, not fabricated | `deploy/docker-compose.prod.yml` runs `@stopgap/shadow replay` for both fixed demo tenants after the idempotent seed in demo mode; `packages/shadow/scripts/replay.ts` skips recorded daily entries before model calls and writes observational measured rows; migration `0024_icy_barracuda.sql` backfills legacy days safely and enforces fresh daily idempotence; `docs/deploy.md` documents the manual backfill. |
| Demo scenario limits | Delivered — anonymous quota identity plus cookie-churn guard | `apps/console/app/lib/actions.ts` issues the httpOnly UUID cookie; `packages/demo/src/scenario.ts` passes it through; `packages/db/src/demo-runs.ts` reserves/counts by `(org_id, visitor_id)` and `(org_id)` under one advisory lock; migration `0023_lyrical_thor_girl.sql` persists the visitor id. Clearing the cookie cannot exceed `DEMO_MAX_RUNS_PER_HOUR_TOTAL`; the optional daily spend cap remains an additional hard boundary. |
| Ollama container and over-cap fallback rehearsal | Container runtime delivered locally; full deployment proof remains | `ollama/ollama:0.5.7` started on CPU with the cached local model store and returned a `mistral:latest` generation; `packages/providers/src/route.test.ts` proves the budget switch. The full production Compose network and over-cap request path remain VPS/runtime follow-up. |
| Gemini, Resend, Langfuse, optional openFDA and ASHP credentials | Configuration blockers | Providers are implemented; absent credentials produce non-configuration/non-delivery. No credential was invented or copied from `.env.local`. |
| Old Phase 1 deferred CodeRabbit findings | Superseded/closed | HMAC + anchors and feed-resolution detection are Phase 6 PR #6; package build limitation is documented and remains true by design. |
| Old “no auth” note | Superseded/closed | Phase 6 PR #7/#9 provide OIDC/RBAC and scoped API authorization. The historical note is retained only under `PHASE5-TODO.md`; current auth and deployment docs describe explicit demo versus non-demo fail-closed behavior. |
| Phase 3 shadow cost/provider/trace details | Intentional follow-up | `PHASE5-TODO.md:106-117` records the limits; no requirement promoted them into Phase 6 or the unified programme. |

## C. Phase 6 successor plan

| Workstream and acceptance | Status | Evidence |
|---|---|---|
| 6.1 RBAC/OIDC: Keycloak seed, middleware protection, role matrix, server-side privilege refusal, real user identity in audits, explicit-demo anonymous path and non-demo fail-closed path. | Delivered — current receipt | `apps/console/auth.ts`, `auth.config.ts`, `middleware.ts`, `auth-guards.ts`, identity migration/tests; auth browser 5/5; zero-config CSP/principal regression tests. |
| 6.2 HMAC/anchors: historical tamper failure, keyless recomputation failure, hourly anchors, verification UI/CLI. | Delivered; dev receipt intentionally red | `packages/db/src/audit.ts`, anchor activities/routes, `pnpm verify-audit`, audit tests and PR #6. The CLI correctly detected the preserved historical row-7 fork; `docs/post-mortem.md` records why the append-only dev artifact is not rewritten. |
| 6.3 Escalation: durable severity ladder, notification/non-delivery/audit identity, ack signal/table, time-skip and restart behavior. | Delivered | `packages/workflows`, escalation/ack actions, `packages/comms`, tests; PR #8. |
| 6.4 Observability: metrics, Prometheus/Grafana dashboards, Alertmanager rules, `/healthz`/`/readyz`, worker sidecar and runbook. | Delivered | `packages/observability`, `deploy/prometheus`, `deploy/grafana`, `docs/observability.md`, health routes; PR #8 and local Compose services. |
| 6.5 Tenancy: org backfill/FKs, RLS FORCE policies, app/maintenance role split, org context in DB/Temporal/console/audit, disjoint seeded orgs. | Delivered — current receipt | migrations 0013–0022, `withOrgDb`, org picker, tenant tests; `pnpm test:rls` 259/259 passed using `stopgap_app`, 0 skipped. |
| 6.5 open questions: ordinary multi-org pharmacist membership, per-org escalation policies, per-org Prometheus labels. | Intentional boundary | Explicitly deferred in `PHASE6-PLAN.md:174-193`; implementing them would be a new approved feature, not a stale checkbox. |
| 6.6 Feed resolution: miss counter, explicit resolved status, flap/reopen behavior, audit evidence and time-skip tests. | Delivered | `packages/workflows/src/activities.ts`, feed-resolution tests and PR #6. |
| 6.7 Public API: scoped hashed keys, rate limits/revocation, API role matrix, OpenAPI/Swagger, MCP through API only. | Delivered | `apps/console/app/api/v1`, `api-auth`, `api-schemas`, `packages/mcp`, API tests, PR #9. |
| Cross-cutting: additive migrations, privileged audit identity, hard `pnpm gate`, eval as signal, truthful progress updates. | Delivered/maintained | Migration/e2e suites, audit tests, `package.json`, `PROGRESS.md`, this ledger; final gate green with 75 files/892 tests. |

## D. Unified-platform tickets (`.scratch/unified-platform/issues/01–21`)

Every ticket file currently has all acceptance boxes checked except the two explicitly closed
by decision/owner action below. The ticket files themselves record closeout re-verification against
the tree on 2026-07-31; current gate/browser/RLS receipts are listed above.

| Ticket | Non-superseded acceptance covered | State/evidence |
|---|---|---|
| 01 | Keycloak realm/client and seeded viewer, pharmacist, director and admin users. | Delivered; `.scratch/.../01-keycloak-seeded-role-users.md`; auth browser 5/5. |
| 02 | Token layer, shared primitives, accessible states and design adoption. | Delivered in batch B/#34 and closeout #38; design tests and current screenshots. |
| 03 | Role route groups, shared shell/layouts, role guards and landing redirects. | Delivered in batch B/#34; auth browser proves each landing. |
| 04 | Isolated Playwright auth/demo projects, real Keycloak sign-in, role landings, refusal control and anonymous demo boundary. | Delivered in batch B/#34; `pnpm test:browser` 5/5 and `pnpm test:browser:demo` 4/4. |
| 05 | Normalized connector contract, shortage/recall/device feeds, dedupe and fixture-backed feed behavior. | Delivered #14; `packages/ingest` and ticket 05 criteria. |
| 06 | Tenant risk signals/snapshots, indexes, policies, snapshots and persistence. | Delivered #18; schema/migrations/RLS suite. |
| 07 | Deterministic versioned scorer, component breakdown, incomplete-data honesty and invariants. | Delivered #19; `packages/scorer` tests and viewer screenshots. |
| 08 | Viewer overview, ranked queue, headline counts, signals, filters/search/URL state, pagination and evidence links. | Delivered batch B/#34; viewer screenshot and design tests. |
| 09 | Evidence artifacts, source links, case evidence drawer and tenant-scoped evidence records. | Delivered #20; ticket 09 and case-detail screenshot. |
| 10 | Compliance guard at model/render/send boundaries, structured violation report and adversarial coverage. | Delivered; ticket 10 and compliance/injection suites. |
| 11 | Pharmacist queue, evidence/alternatives/confidence, exception path, approve/edit/reject, refusal-by-role, audit and durable workflow signals. | Delivered batch B/#34; queue/case screenshots, action/workflow tests. |
| 12 | Alert rules, item/category/severity matching, cooldown/idempotency, reconcile, chat/email/non-delivery and tenant scope. | Delivered #22; alert tests and PR #38 closeout. |
| 13 | Structured daily brief, provider routing/failover, trace/compliance/tenant durability and honest unavailable state. | Delivered #31; brief package/tests. |
| 14 | Director approvals, shadow/gates/alerts/trends/spend/role controls and oversight surface. | Delivered #37; director screenshot and ticket 14 criteria. |
| 15 | Catalog tables, typed identifiers, CSV parse/validation/atomicity/idempotent re-import, browse/search/detail and RLS/migrations. | Delivered #15; catalog migration/RLS tests and admin screenshots. |
| 16 | Signal-to-catalog matching, deterministic score completion, sole-source/exposure context and mock retirement. | Delivered #15; matching/scorer/catalog tests. |
| 17 | Admin setup/health, catalog management, matching/detail/sole-source, connector health, user/role/API/org management, demo seed. | Delivered #37/#38; connector migration 0022 and current RLS. Model spend cap is **closed by decision**, with truthful read-only status in the admin page; no unsafe per-tenant control was added. |
| 18 | Retention policy/schedule, tenant scope, audit integrity and durable runtime behavior. | Delivered #15; retention tests/workflow and ticket 18 criteria. |
| 19 | Scoped public API for signals/scores/catalog, OpenAPI vocabulary and tenant authorization. | Delivered #15/#9; API route tests/OpenAPI tests. |
| 20 | Absorption record, adopted/non-adopted capability record, no live dependency on the absorbed repo, regression proof. | Repository work delivered; source repository README replacement/archive command are prepared in `docs/absorption.md` but must be run by the owner on the other repository. |
| 21 | All tenant-to-tenant FKs use `(org_id,id)`, explicit delete semantics, catalog/risk coverage, realistic-role isolation, migration/data preflight and recorded reasoning. | Delivered via migration `0021_yielding_impossible_man.sql`; `tenant-keys.e2e.test.ts` and current RLS suite. |

## E. Console design plan

| Plan | Requirement | Status/evidence |
|---|---|---|
| P0 0.1–0.7 | Spacing fix; visible API-key toggles; labels; alert roles; route error/loading states; a11y lint/plugins; TSX test inclusion. | Delivered in PRs #39/#41; design adoption, component and lint/typecheck receipts. |
| P1 1.1–1.5 | Ink/platinum/elevation tokens; Geist fonts; type scale/tabular figures; 4px spacing aliases; achromatic interaction tokens. | Delivered in PRs #39/#41; token/font/type/spacing tests and current screenshots. |
| P2 2.1–2.6 | Persistent left rail and mobile fallback; data/prose measures; scrollable labeled tables; shared Card/Badge/Table primitives; mobile KV wrapping; heading/style cleanup. | Delivered in PRs #39/#41; 14 current desktop/mobile captures reported no browser errors/failed requests. |
| P3 3.1–3.6 | Ledger Rail; KPI figure tiles; overview/oversight figures and sparklines; queue/overview sort affordances; human filter labels; reduced-motion interaction pass. | Delivered in PRs #39/#41; design tests, current role screenshots, reduced-motion/forced-colors code/tests. |
| P4 4.1–4.6 | Enable disabled users; revoke/disable confirmation; one-time API-key caution/copy; conditional table focus; CSP/security headers/HSTS boundary; icon set. | Delivered in PRs #39/#41. This branch additionally fixes default-Keycloak CSP and removes Auth.js's remote provider icon dependency. |
| Design DoD | Green gate/browser; desktop 1440 and mobile 375 role/case/admin captures; no horizontal scroll; contrast; keyboard review→approve and issue→revoke; reduced-motion/forced-colors; no legacy style/class violations. | Source/PR receipts plus the 14 clean 1440/mobile captures and the final exact-375 proof for overview, queue, case detail, oversight, admin, API keys and users. The exact-375 run reported `documentElement.scrollWidth` and `body.scrollWidth` of 375 for every surface, with zero browser errors/warnings and failed requests; contrast, reduced-motion and forced-colors source tests remain green. Any external production-host verification remains outside the repo. |
| Design out of scope | Light mode, chart-library adoption, copy/information-architecture/honesty changes. | Intentional boundary in `docs/design-direction.md`; none was added. |

## F. Explicit exclusions and blockers

- The expansion roadmap and “Do not build yet” list in the user-owned current report are proposals,
  not approved successor requirements. No Protocol Drift Sentinel, Evidence Capsule, Counterfactual
  Supply Lab, Connector Observatory, Fire Drill, Decision Flywheel or Tenant Policy Pack was added.
- No autonomous approval/promotion, PHI/patient feature, generic chatbot, cross-hospital protocol
  sharing, billing, multi-region complexity, live price fetching or model retraining was added.
- The remaining blockers are owner-controlled external actions: paid VPS/public DNS/TLS, npm and
  second-repository publication, public cross-post/video, credentials for Gemini/ASHP/Resend/
  Langfuse, and the in-cluster Ollama/over-cap fallback rehearsal. The code records these as
  unavailable rather than fabricating success.

## Final closeout fields

| Field | State |
|---|---|
| Repo-controllable code gaps | None found after the auth, visitor-quota aggregate bound, measured-replay, Compose interpolation and mobile-overflow fixes. The dev-only audit CLI failure is a known preserved data-integrity receipt, not a reason to rewrite history. |
| Required docs reconciled | Complete in this closeout: `PHASE5-TODO.md`, `PHASE6-PLAN.md`, `PROGRESS.md`, `docs/unified-platform-spec.md`, `docs/design-direction.md` and this ledger now distinguish delivered work, intentional boundaries and owner actions. |
| Final local gate | Green: `pnpm gate` completed lint, typecheck, 75 test files/892 tests and production build. |
| Local review/autoreview | Pending post-change diff review. |
| PR/CodeRabbit | No PR yet for this branch; docs-only changes may land directly, but source fixes will use the mandatory PR review flow. |
| Main synchronization | Pending commit/push/PR merge, then live recheck. |
