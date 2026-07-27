# Spec — unified supply-resilience platform with role-based dashboards

**Status:** draft, ready for review
**Scope:** absorbing `medical-supply-monitor` into stopgap, plus a role-differentiated interactive console
**Direction:** fixed — stopgap is the surviving repository; `medical-supply-monitor` is absorbed and archived. The reverse merge is not under consideration.

---

## Problem Statement

A pharmacist opening the stopgap console today sees a chronological list of cases. When a feed poll opens fifty-seven cases in a single pass — which has happened, and is recorded in the build log — the console offers no way to answer the only question that matters: *which of these do I look at first?* There is no sorting, no filtering, no search, no pagination, and no notion of relative risk. The list is the same list whether it holds three cases or three hundred.

The situation is worse than "unsorted", because the console has no picture of the hospital's actual exposure. Impact assessment runs against a mock formulary and mock inventory. Nobody has told stopgap which drugs this hospital actually stocks, how many days of each it holds, which items come from a single supplier, or which suppliers are themselves under strain. A case for a drug the hospital does not carry looks exactly like a case for the one critical-care item with four days on hand and one manufacturer.

Meanwhile the authorization system is invisible. Stopgap has a genuine four-role matrix enforced server-side on every mutating action, but no user can sign in to experience it: the identity provider is documented and wired and has never been stood up, so `authConfigured()` returns false, everyone resolves to an anonymous viewer, and the deployment sits locked read-only. A pharmacy director evaluating the product cannot log in as themselves and see the surface they would actually work in. A reviewer cannot see the role system exists without attempting to break it.

Separately, a second codebase — `medical-supply-monitor` — already solves large parts of this. It has a deterministic, versioned, explainable risk scorer; a source-agnostic connector contract with ten feeds behind it; a catalog and CSV import covering items, identifiers, suppliers, facilities and inventory; an alert-rule engine with cooldowns; and a complete interactive dashboard component library. It sits in a separate repository, on an incompatible runtime, duplicating stopgap's feed ingestion and tenancy with weaker guarantees. Every hour spent maintaining two pipelines, two review gates, two deploys and two demo modes is an hour not spent on the product.

## Solution

Fold the durable, portable parts of `medical-supply-monitor` into stopgap, and build a console where each of the four roles lands in a dashboard shaped around what that role actually does.

Concretely, four things change for users:

**You can log in, as yourself, with your role.** The identity provider is stood up for real with a seeded user per role. Signing in as a pharmacist puts you in the pharmacist's dashboard; signing in as an admin puts you in the admin's. The role matrix that already governs every mutating action becomes something you can see and demonstrate, not just something that refuses you.

**Every queue is ranked by risk, not by clock.** A deterministic scorer — versioned, explainable, and never computed by a model — assigns each case and signal a score with a visible component breakdown. A pharmacist opening the queue sees the highest-exposure case first and can read exactly why it ranks there: which risk domains matched, how fresh the evidence is, how many days on hand remain, whether the item is sole-sourced.

**The platform knows your hospital.** An admin uploads the facility's catalog — items with their NDC, GTIN, UPC, SKU, MPN, FDA application number and RxCUI identifiers; suppliers and their sites; facilities; inventory snapshots. Incoming signals match against that catalog. Impact assessment stops being a simulation. The mock formulary retires.

**The console is interactive.** Every list supports search, filter, sort and pagination, with that state carried in the URL so a director can send a colleague a link to exactly the view they are looking at. Evidence opens in a drawer rather than a page load. Alert rules can be created and tuned, with cooldowns that stop a fifty-seven-case poll becoming fifty-seven notifications.

Underneath, four architectural commitments hold the shape:

- **Postgres row-level security remains the tenancy boundary.** Every table arriving from `medical-supply-monitor` gets an `org_id` and an RLS policy, and every read goes through the org-scoped transaction helper. The absorbed code inherits a stronger isolation guarantee than it had.
- **The deterministic spine keeps the judgment.** Per ADR-0002, the risk score is code, never a model output. Language models continue to draft prose and propose alternatives behind schema-validated structured output and confidence routing. The scorer's version is pinned into every snapshot for audit.
- **Temporal remains the only orchestrator.** The absorbed scheduling work is re-expressed as Temporal workflows. No second job runtime enters the repository.
- **Server-side refusal remains the security boundary.** Role-shaped dashboards change what is convenient, never what is permitted. A control that a role may not use renders disabled with a stated reason rather than hidden, so the authorization model is legible; the server refuses regardless of what was rendered.

Delivery is sequenced as a thin foundation followed by four vertical slices, one per role, each independently demoable and each a coherent stopping point.

---

## User Stories

### Signing in and role identity

1. As a pharmacist, I want to sign in with my hospital SSO account, so that I can act as myself and have my decisions attributed to me in the audit chain.
2. As a pharmacy director, I want my role to be recognised from my identity provider claims without an administrator granting it manually, so that onboarding does not require a second step.
3. As an administrator, I want to grant and revoke roles locally for users whose identity provider claims are wrong or missing, so that I can correct access without an identity provider change.
4. As a pharmacist, I want to be taken to my own work surface immediately on sign-in, so that I do not have to navigate to find my queue.
5. As an anonymous visitor to the public demo, I want to browse a read-only dashboard without signing in, so that I can evaluate the product without an account.
6. As an anonymous visitor, I want every mutating control to be visibly present but refused, so that I understand what the product does without being able to alter anything.
7. As a security reviewer, I want a signed-in pharmacist attempting a director-only action to be refused by the server, so that I can confirm the interface is not the boundary.
8. As an operator, I want a deployment with no identity provider configured to remain locked read-only rather than open, so that a missing secret fails closed.
9. As an administrator, I want to see which users hold which roles and when each grant was made, so that I can audit access.
10. As a pharmacy director, I want my session's organization to determine everything I can see, so that I cannot accidentally read another facility's data.

### Viewer dashboard — situational awareness

11. As a viewer, I want a single overview page showing current exposure across the facility, so that I can understand the situation without opening individual cases.
12. As a viewer, I want open cases ranked by risk score rather than by creation time, so that the most consequential item is first.
13. As a viewer, I want to see the count of open cases, cases awaiting review, and cases in the exception queue as headline figures, so that I can gauge workload at a glance.
14. As a viewer, I want to browse incoming risk signals with their source, domain, severity and freshness, so that I can see what the system is reacting to.
15. As a viewer, I want to filter signals by risk domain, so that I can look at shortages separately from recalls.
16. As a viewer, I want to filter signals by severity and by freshness, so that I can ignore stale or low-severity noise.
17. As a viewer, I want to search signals and cases by drug name or identifier, so that I can answer a question about a specific product quickly.
18. As a viewer, I want the filters and search I have applied to appear in the page URL, so that I can bookmark a view or send it to a colleague.
19. As a viewer, I want to page through long lists rather than loading everything at once, so that the page stays responsive with hundreds of rows.
20. As a viewer, I want to click a signal and see the evidence behind it, including a link to the originating source record, so that I can verify the claim myself.
21. As a viewer, I want to see when each signal was last fetched and whether its source considers it resolved, so that I do not act on a hazard that has passed.
22. As a viewer, I want a case's risk score to show its component breakdown, so that I can see why it ranks where it does rather than trusting a number.
23. As a viewer, I want to see plainly when part of the score is unavailable because catalog data has not been loaded, so that I am not misled into thinking the score is complete.

### Pharmacist dashboard — the review queue

24. As a pharmacist, I want my landing page to be the queue of cases awaiting my review, so that my work is in front of me without navigation.
25. As a pharmacist, I want that queue ranked by risk score, so that I spend my attention where exposure is greatest.
26. As a pharmacist, I want to filter my queue by severity, status and risk domain, so that I can work through one category at a time.
27. As a pharmacist, I want to sort my queue by score, age, or drug name, so that I can choose my own working order.
28. As a pharmacist, I want to open a case and read the drafted protocol alongside the evidence that produced it, so that I can judge it without leaving the page.
29. As a pharmacist, I want to see the proposed alternatives with the model's stated confidence, so that I can weigh how much to trust the draft.
30. As a pharmacist, I want a case where the model's confidence was too low to have been routed to the exception queue rather than auto-drafted, so that a shaky suggestion never looks authoritative.
31. As a pharmacist, I want to approve, edit or reject a drafted protocol, so that a human decision governs every substitution.
32. As a pharmacist, I want my edit to be recorded distinctly from an outright approval, so that the audit trail reflects what I actually did.
33. As a pharmacist, I want to resolve a case sitting in the exception queue, so that cases the pipeline could not handle do not accumulate.
34. As a pharmacist, I want any agent-generated text that contains protected health information, diagnosis or treatment language, or patient-specific detail to be blocked before it reaches my screen, so that the platform's non-clinical boundary is enforced rather than assumed.
35. As a pharmacist, I want to see the affected item's current inventory position and supplier concentration inline on the case, so that I can judge urgency without opening another system.
36. As a pharmacist, I want to see whether a proposed alternative is itself under shortage or recall, so that I do not substitute into a second problem.
37. As a pharmacist, I want controls for actions above my role to render disabled with the required role stated, so that I understand the workflow rather than wondering where a button went.
38. As a pharmacist, I want my approval to be written into the tamper-evident audit chain with my user identity, so that "who authorized this" is machine-checkable.

### Pharmacy director dashboard — oversight and governance

39. As a pharmacy director, I want my landing page to show pending protocol approvals and facility-level trend figures, so that I begin with governance rather than individual cases.
40. As a pharmacy director, I want to approve or supersede a protocol version directly, so that standing practice is under my control.
41. As a pharmacy director, I want to see the version history of a protocol and what changed between versions, so that I can understand how practice evolved.
42. As a pharmacy director, I want to see how often the system's shadow-mode proposals agreed with human decisions, broken down by cohort, so that autonomy is granted from measured agreement rather than from a demonstration.
43. As a pharmacy director, I want promotion gates to state which criteria are met and which are not, so that I know exactly what would have to change to widen automation.
44. As a pharmacy director, I want to create and edit alert rules scoped to items, categories or severities, so that notifications reflect what my team cares about.
45. As a pharmacy director, I want each alert rule to have a cooldown, so that a single ingestion run cannot generate dozens of duplicate notifications.
46. As a pharmacy director, I want to see the history of alert events with their outcome, so that I can tune rules against what actually fired.
47. As a pharmacy director, I want alerts delivered to a team chat channel as well as by email, so that they arrive where my team already works.
48. As a pharmacy director, I want a daily brief summarising what changed and what needs review, so that I can stay current without watching the console.
49. As a pharmacy director, I want the escalation ladder for unacknowledged critical cases to be visible and configurable, so that nothing critical goes unowned.
50. As a pharmacy director, I want to see key performance figures over time rather than only as current values, so that I can tell whether the situation is improving.
51. As a pharmacy director, I want to see how much has been spent on model inference against the configured cap, so that cost does not surprise me.

### Administrator dashboard — operations and data

52. As an administrator, I want my landing page to show setup completeness and system health, so that I can see what still needs configuring.
53. As an administrator, I want to upload our item catalog by CSV, so that the platform reflects what this facility actually stocks.
54. As an administrator, I want the import to accept multiple identifier types per item — NDC, GTIN, UPC, SKU, MPN, FDA application number and RxCUI — so that our data matches however our systems record it.
55. As an administrator, I want to upload suppliers, supplier sites, facilities and inventory snapshots, so that exposure calculations have real inputs.
56. As an administrator, I want the import to validate rows and report precisely which rows failed and why, so that I can correct a file rather than guess.
57. As an administrator, I want a failed import to leave no partial data behind, so that a bad file does not corrupt the catalog.
58. As an administrator, I want to re-upload a corrected file without creating duplicates, so that fixing a mistake is safe.
59. As an administrator, I want to browse and search the imported catalog, so that I can confirm the upload landed correctly.
60. As an administrator, I want to open an item and see its identifiers, suppliers, inventory position, and any risk signals matched to it, so that I have one place to understand a product.
61. As an administrator, I want to see which items are sole-sourced, so that I can prioritise diversifying supply.
62. As an administrator, I want to see the health and last-run time of every data connector, so that I can tell when a feed has gone silent.
63. As an administrator, I want to manage API keys with their scopes and see when each was last used, so that machine access is controlled and reviewable.
64. As an administrator, I want to configure spend caps for model inference, so that cost is bounded by policy.
65. As an administrator, I want old records to be cleaned up on a schedule according to a retention policy, so that the database does not grow without limit.
66. As an administrator, I want to seed a demo workspace containing no real facility data, so that I can show the product without exposing anything.
67. As an administrator operating across facilities, I want to switch my active organization explicitly, so that cross-tenant work is deliberate and recorded.

### Machine and operator access

68. As an API consumer, I want risk signals and scores exposed through the versioned public API under the same scoped-key authorization as existing resources, so that I can integrate without a second auth mechanism.
69. As an API consumer, I want the OpenAPI document to describe the new resources, so that I can generate a client.
70. As an operator, I want every model call to continue emitting a trace with provider, model, token counts, cost and latency, so that behaviour stays observable after the merge.
71. As an operator, I want the metrics endpoint to expose ingestion, scoring and alerting counters, so that I can alert on the pipeline itself.
72. As an operator, I want the local build gate to remain fully offline and deterministic, so that a green gate keeps meaning something.
73. As an operator, I want database-dependent tests to stay opt-in and separate from the default gate, so that contributors without a database can still work.

---

## Implementation Decisions

### Direction and repository outcome

Stopgap is the surviving repository. `medical-supply-monitor` contributes code and design and is archived once the catalog slice lands, with its README redirected. No history graft: absorbed code arrives as ordinary reviewed pull requests through the existing branch → review → squash-merge workflow.

### Authorization — extend, do not replace

The existing four-role rank (`viewer` < `pharmacist` < `pharmacy_director` < `admin`) and the console action matrix are kept exactly as they are. No roles are added, no action requirements change, and the absorbed codebase's organization/authorization model is discarded entirely rather than reconciled — it offers application-layer filtering where stopgap already enforces isolation in the database.

The identity provider is stood up for real: added to the local compose stack and the deployment stack, with a realm seeding one user per role so that the matrix is demonstrable from a clean checkout. The honest-non-configuration stance is preserved unchanged — with secrets absent, no one can sign in, requests resolve to an anonymous viewer, and every mutating action is still refused. Fail-closed, never fail-open.

One pure addition to the authorization module: a function mapping a role to its landing route. It takes a role and returns a route group identifier, with no session, database or framework dependency. This is what makes per-role routing unit-testable without a browser.

### Console structure — route groups per role

The console is reorganised into four route groups, one per role, each with its own layout and navigation. This is the mechanism that satisfies role-specific dashboards without the cost the current root layout deliberately avoids: reading session state in the root layout would make every route in the application per-session dynamic. A group-level layout makes only its own subtree dynamic, leaving the root static.

Middleware resolves the signed-in principal's highest role and redirects to that group's landing route. The anonymous demo visitor maps to the viewer group, which makes the public demo and the lowest-privilege dashboard the same surface — one thing to build, one thing to keep honest.

Navigation within a group is that group's own concern. Cross-group links are not rendered for roles that lack the action, but this remains a convenience: every page and every action re-checks authorization server-side, so a guessed URL is refused exactly as an unauthenticated request is.

Controls for actions above the current role render **disabled with the required role stated**, rather than hidden. Concealment would make the authorization model invisible, which is the opposite of the goal; and hiding has never been the boundary.

### Design system — tokens first, framework second

A utility-first CSS framework is adopted, but the existing console palette is declared as the framework's theme rather than replaced. The current custom properties — surface, panel, line, text, muted, accent, and the severity ramp — become the token layer, so the console's established dark identity *is* the design system. Existing pages continue to work untouched against the existing stylesheet; new surfaces are built against tokens. There is one palette, not two, and no big-bang restyle.

A small set of presentational primitives is ported from the absorbed codebase — badge, button, card, input, table — restyled onto those tokens. Icons come from the same source. The absorbed dashboard *pages* are not ported: they target a different major framework version and a different authorization system. Components port; pages are rebuilt.

### Interactive list state — pure, and in the URL

List interaction state — search text, active filters, sort key and direction, page number and page size — is parsed and serialised by a **pure module** with no framework dependency, and carried in the URL query string. Two consequences are deliberate: the state is shareable and survives the back button, and it is unit-testable without rendering anything.

Server components read that state and query accordingly; client-side table behaviour is layered on top for responsiveness but is never the source of truth. A shared table component, search input, pagination control, loading skeleton and error boundary are ported from the absorbed codebase and reused by all four dashboards.

### Risk scoring — a new pure package

The absorbed deterministic scorer becomes a standalone package alongside the existing dependency-free ledger package, which is the model to follow: pure functions, no database, no network, no framework.

Its guarantees are preserved verbatim and are the reason it is worth taking:

- **Deterministic.** Identical inputs and an identical evaluation timestamp produce an identical output.
- **Explainable.** Every score carries a per-component breakdown.
- **Versioned.** A scoring version constant is pinned into every persisted snapshot; any change to weights or formula bumps it.
- **Auditable.** Inputs are captured without raw provider payloads.
- **Monotonic.** Additional matched signals can raise a score, never lower it. Additional matched risk domains contribute at a shrinking but strictly positive factor. A source-resolved hazard is decayed rather than removed, so it still contributes non-negatively.

Per ADR-0002 this sits squarely on the deterministic side of the spine. A model never computes, adjusts or overrides a risk score.

The score budget is fixed and worth stating explicitly, because a third of it is dormant until the catalog slice lands:

| Component | Share | Available from |
| --- | --- | --- |
| Matched signal severity, domain-weighted and freshness-decayed | 65 | Slice 1 |
| Days on hand | 20 | Slice 4 |
| Sole-source exposure | 15 | Slice 4 |

Until inventory and supplier data exist, thirty-five points are structurally unreachable. Scores remain valid, comparable and monotonic, but incomplete. **The console states this rather than concealing it** — the same stance the repository already takes toward unconfigured providers and non-delivered communications. A score that silently omits a third of its basis is a worse failure than one that admits it.

### Ingestion — one connector contract

The absorbed source-agnostic connector contract replaces the current bespoke per-feed shapes in the ingestion package. Every feed implements the same interface and emits the same normalized signal type. Connectors are pure adapters: fetch, normalize, emit. They never write to the database, never score, and never send notifications.

The normalized signal carries source, risk domain, entity type and identifier, title and summary, severity with a numeric severity for scoring, confidence, observation and publication timestamps, last-fetched time, a staleness classification, an evidence URL, the raw provider payload retained as evidence, a stable dedupe key scoped to organization and source, and match hints used downstream to associate the signal with a catalog item.

Two distinctions in the contract are load-bearing and are preserved:

- **Source-resolved** (the provider marks the hazard terminated or completed) is *not* the same as **feed-absent** (the signal disappeared and was reconciled away). The first is a weighting input to the scorer; the second is a status transition. Collapsing them would silently misweight resolved hazards.
- **Default signal confidence** is a single exported constant shared by the scorer and the matching layer. This coupling is intentional — two copies would drift, and a drift between "how confident is this signal" in matching versus scoring is exactly the kind of bug that produces plausible wrong numbers.

Feeds adopted: the existing shortage sources, plus recalls and device shortages from the same regulator. Recalls matter directly to this product — substituting into a recalled alternative is the failure mode the pipeline exists to prevent. The remaining connectors in the absorbed codebase (geopolitical, seismic, weather, wildfire, sanctions, cyber-vulnerability, chemical-restriction and trade-policy) are **not** adopted; the contract keeps that door open without widening the product's claim.

### Orchestration — Temporal only

All absorbed scheduling is re-expressed against the existing durable workflow runtime. The absorbed serverless job framework does not enter the repository. The existing feed-poll workflow gains the new connectors; scoring, matching, alert evaluation and retention cleanup become activities or scheduled workflows on the same spine.

The feed poll remains the one caller with no organization in its context, and continues to resolve this the way the tenancy design already prescribes: enumerate organizations and perform a full pass per tenant inside an org-scoped transaction, rather than inventing an organization.

### Schema and tenancy

New tables arrive in two waves.

*Risk wave:* risk signals, risk snapshots, evidence artifacts.
*Catalog wave:* items, item identifiers, suppliers, supplier sites, item-supplier relationships, facilities, inventory snapshots, procurement events.

Every one of these is a **tenant** table: it carries an organization foreign key and a row-level security policy keyed to it, and every read passes through the org-scoped transaction helper. The belt-and-braces convention is retained — query helpers also take an explicit organization identifier and keep an explicit predicate, so that a query which loses its scope returns zero rows (a visible, reportable, test-failing outcome) rather than silently returning everything.

The tenant-versus-global decision is recorded beside each table definition, as the existing tenancy documentation requires. One case needs explicit reasoning rather than reflex:

**Risk signals are tenant-scoped, even though the underlying feed record is global.** The existing global feed-record table stores the raw external fact — one regulator record is one physical fact about the supply chain, identical for every hospital, and per-tenant copies would multiply poller writes by tenant count and break the source-level dedup contract. A risk signal is different: it is the *matched, scored, tenant-relevant interpretation* of that fact against a particular facility's catalog and inventory. Two hospitals reading the same recall have genuinely different signals. The dedupe key is therefore scoped to organization and source, exactly as the absorbed contract already defines it.

Alert rules, alert events and human review tasks are likewise tenant tables. The existing global tables — feed records, model spend, and the organization registry itself — keep their current classification and reasoning. Whether the escalation ladder becomes per-organization is deferred; it is noted as a pending decision in the existing tenancy documentation and this spec does not resolve it.

### Catalog and import

The import pipeline parses CSV, coerces and validates rows, and applies them within a single transaction per upload. Validation failures are reported per row with the reason, and a failed import leaves no partial state. Re-uploading a corrected file is idempotent against the item identifier set rather than creating duplicates.

Items carry multiple typed identifiers because facilities record products differently across systems; matching consumes all of them. Once the catalog exists, incoming signals are matched to items via the contract's match hints, and the scorer's dormant days-on-hand and sole-source components activate.

The existing mock formulary and inventory sources are retired at this point and the impact-assessment activity reads the real catalog. Until then they remain, so no slice leaves the pipeline unable to run.

### Alerting — one brain, not two

The absorbed alert-rule engine and the existing escalation ladder overlap and must be reconciled into a single mechanism rather than run side by side. The intended division: **rules decide what fires and when**, the **ladder decides who is told and what happens if nobody acknowledges**. Rule evaluation contributes cooldown-aware triggering scoped to items, categories and severities; the ladder contributes ownership, acknowledgment and escalation on silence.

Cooldowns are a correctness requirement, not a refinement. A single recorded poll opened fifty-seven cases; without cooldowns that is fifty-seven notifications from one event, which trains recipients to ignore the channel.

A team-chat delivery channel is added alongside the existing email transport, under the existing communications package and its idempotency and honest-non-delivery guarantees: a missing credential is recorded as unconfigured and never faked as sent.

### Daily brief — reimplemented, not ported

The daily brief is adopted as a *concept*. Its implementation is rewritten against the existing model-provider registry and structured-output path, so that it inherits provider health-check failover, cost and latency logging, and the tracing established in ADR-0003. The absorbed graph-orchestration and hosted-tracing libraries are not adopted; the repository already has a provider abstraction and a self-hosted tracing backend, and a second of each would fragment observability.

### Compliance guard

A content guard is adopted from the absorbed codebase and applied at two points: to model-generated text before it is rendered in the console, and to any outbound communication payload before send. It screens for protected health information patterns (record numbers, dates of birth, national identifiers, contact details), electronic-record-system references, diagnosis and treatment language, patient-specific phrasing, and substitution directives, returning a structured violation report rather than a boolean.

This is the runtime enforcement of a claim the product currently makes in prose. It is placed at the render and send boundaries specifically because those are the points where content leaves the system's control.

### Public API

Risk signals, risk scores and catalog resources are exposed through the existing versioned API under the existing scoped-key authorization, and described in the existing generated OpenAPI document. No new authentication mechanism is introduced. The organization continues to derive from the presented key.

### Retention

Scheduled retention cleanup is adopted and expressed as a Temporal schedule. It covers the new high-volume tables — signals, snapshots and alert events — alongside existing candidates.

### Explicitly not adopted

The absorbed codebase's hosted authentication and organization webhooks; its serverless job runtime; its graph-orchestration and hosted-tracing libraries; its dashboard pages as written; its error-reporting and managed-cache services; and the eight non-regulatory connectors. Each is either superseded by an existing stopgap capability with stronger guarantees, or represents scope the product deliberately does not claim.

### Delivery sequence

**Foundation.** Identity provider stood up with seeded per-role users and a working sign-in; design tokens mapped; presentational primitives ported; route groups, per-role layouts and role redirect in place; pure list-state module and shared list components landed.

**Slice 1 — viewer.** Connector contract adopted; scorer package landed; recall and device connectors added; risk signal and snapshot tables with policies; viewer overview with ranked queue, signals list and headline figures.

**Slice 2 — pharmacist.** Interactive review queue; evidence artifacts and evidence drawer; compliance guard at render and send; review panel upgraded to disabled-with-reason controls.

**Slice 3 — director.** Alert rules with cooldowns reconciled against the escalation ladder; alert history and metrics; team-chat delivery; daily brief reimplemented; shadow agreement and promotion gates surfaced.

**Slice 4 — admin.** Catalog schema and policies; CSV import; catalog browsing and item detail; signal-to-catalog matching; dormant score components activated; mock formulary retired; connector health; retention schedule; setup checklist.

Each slice is independently demoable and is a coherent stopping point. Each is delivered as a chain of reviewed pull requests, not a single change.

---

## Testing Decisions

### What makes a good test here

A good test in this repository asserts **external, observable behaviour** — what a caller gets back, what a role is permitted to do, what a query returns under a given tenant, what a pure function computes from given inputs. It does not assert internal structure, call ordering, or the presence of particular intermediate values. A test that must change when an implementation is refactored without a behaviour change is a liability; the existing dependency-free ledger package and the exhaustive role-matrix suite are the models to imitate.

Two existing conventions are load-bearing and are preserved:

- **The default gate stays offline and deterministic.** Lint, typecheck, test and build require no database, no network and no model. A green gate must keep meaning something.
- **Non-deterministic signal stays outside the gate.** Live-model evaluation remains a separate, deliberately non-blocking command, for the documented reason that small quantized models vary between identical runs and a hard gate on that noise teaches everyone to ignore red.

### Seams

Four existing seams are reused. One new seam is added and deliberately kept thin.

**1. Pure role matrix (existing, highest available seam).**
The authorization module is already pure — no session, no database — and exhaustively tested. The new role-to-landing-route function is added here for exactly that reason: per-role routing becomes a table-driven unit test over four roles plus the anonymous case, with no browser and no rendering. Every console action's minimum role continues to be asserted exhaustively.

**2. Server actions and API route handlers (existing).**
Mutating behaviour and its authorization refusal are tested at the action and route level, following the existing action, API-authorization and route suites. Each new mutating surface — alert rule creation and editing, catalog import, retention configuration — is asserted to refuse a principal below its required role, and to refuse identically whether the caller is under-privileged or unauthenticated.

**3. Pure domain modules (existing pattern).**
The scorer, the connector normalizers, the list-state parser, the CSV coercion layer and the compliance guard are all pure in-and-out modules tested directly with fixtures — the established pattern in the ingestion package, where recorded provider payloads drive normalization assertions without network access.

Specific properties worth asserting rather than merely covering:
- Scorer determinism: identical inputs and evaluation timestamp produce byte-identical output.
- Scorer monotonicity: adding a matched signal never lowers a total; adding a matched domain never lowers a total; a source-resolved signal contributes non-negatively.
- Scorer versioning: a persisted snapshot always carries the version constant.
- Score incompleteness: with no inventory or supplier data, the unreachable components are reported as unavailable rather than as zero.
- Connector purity: a normalizer performs no writes and no scoring, and produces a stable dedupe key for a repeated payload.
- Confidence default: the scorer and the matching layer resolve the same default from the same constant.
- List-state round-trip: parsing a query string and re-serialising it is stable, and unknown or malformed parameters degrade to defaults rather than throwing.
- Import atomicity at the pure layer: a file containing an invalid row yields a rejection describing that row, not a partial application.
- Compliance guard: known protected-information and clinical-language patterns are detected; the report names the category and the offending excerpt.

**4. Database-backed isolation (existing, opt-in).**
Every new tenant table gets row-level-security coverage in the existing opt-in database tier, which is excluded from the default gate by design. This is non-negotiable: eleven new tenant tables arrive across the risk and catalog waves, and each must be shown to be unreadable and unwritable from another tenant's scope. The existing suite's constraints are respected — it must run as a role the policies actually apply to, because a green isolation suite under a superuser proves nothing, and file parallelism stays off because the suites seed fixed row identifiers.

Migration application is likewise covered by the existing migration suite, which creates and drops a throwaway database and applies migrations as the role a real deployment migrates as.

**5. Browser smoke tier (new, minimal).**
A browser test tier does not currently exist in this repository despite being named in the stack description — there is no configuration, no specification and no dependency. It is added, with configuration adapted from the absorbed codebase, which has a working setup.

It is scoped deliberately narrowly, to the things that genuinely cannot be asserted below it:
- signing in as each of the four seeded role users succeeds;
- each role lands on its own dashboard group;
- a control for an action above the signed-in role renders disabled and states the required role;
- the anonymous demo path reaches the viewer dashboard without authentication and cannot mutate.

Everything else stays below this line. Table sorting, filtering, searching and pagination are asserted through the pure list-state module and the server queries that consume it, not through a browser, because URL-carried state makes that possible. This keeps the new tier small, fast and resistant to restyling — a suite that breaks every time a class name changes will be disabled within a month.

### Prior art to follow

- The dependency-free ledger package, for how a pure domain module is structured and tested.
- The exhaustive role-matrix suite, for table-driven authorization assertions.
- The ingestion suite's recorded-payload fixtures, for normalizer tests without network access.
- The row-level-security and migration suites, for tenant isolation and migration application under a realistic role.
- The absorbed codebase's own tenant-isolation tests, as a source of cases to translate — though the tests themselves are rewritten, since they assume the discarded authorization model.

---

## Out of Scope

- **Any change to the four roles or the action-to-role matrix.** Both are kept exactly as they are.
- **Adopting the absorbed codebase's authentication or organization model.** Discarded entirely.
- **A second job orchestrator.** All scheduling is expressed on the existing durable workflow runtime.
- **Graph-orchestration and hosted-tracing libraries.** The existing provider registry and self-hosted tracing stand.
- **The eight non-regulatory connectors** — geopolitical, seismic, weather, wildfire, sanctions, cyber-vulnerability, chemical-restriction and trade-policy. The contract admits them later; the product does not claim them now.
- **Porting the absorbed dashboard pages as written.** Components port; pages are rebuilt.
- **Error-reporting and managed-cache services.** Added only on measured need.
- **Making the escalation ladder per-organization.** A known pending item, unresolved here.
- **Charting library selection.** Trend visualisation is called for by the director dashboard; the absorbed codebase has no charting dependency to inherit, so this is an open decision, not a settled one.
- **Any clinical function.** No protected health information, no records-system integration, no diagnosis, treatment or patient-specific advice. Drug- and product-level administrative data only, with a human approving every substitution. This boundary is unchanged and the compliance guard exists to enforce it.
- **Migrating the absorbed repository's history.** Code arrives as reviewed pull requests.
- **Provisioning paid hosting.** The deployment stack remains rehearsed locally.

---

## Further Notes

**On the honest-incompleteness stance.** Three of this spec's decisions — the dormant score components being reported as unavailable, the compliance guard returning a structured report rather than a silent pass, and the identity provider failing closed when unconfigured — are the same decision applied three times. The repository already takes this position with unconfigured model providers and non-delivered communications. It is worth naming as a principle rather than rediscovering per feature: **the system states what it does not know, and never fakes success.**

**On the fifty-seven-case poll.** This figure appears twice above, in the problem statement and in the alerting decision, because it is the single most concrete piece of evidence available that both ranking and cooldowns are correctness requirements rather than refinements. It is a recorded real outcome of one ingestion run, not a projection.

**On sequencing risk.** The largest risk in this plan is that Slice 4 — catalog, import, eleven tables, policies and isolation tests — is substantially larger than the three slices before it, while also being the slice that activates a third of the scorer and retires the mock formulary. If the programme stalls anywhere, it stalls there. Two mitigations are built in: the earlier slices are each independently demoable so a stall is not a total loss, and the score's incompleteness is surfaced in the console from Slice 1, so a partially-delivered platform is honest about its own state rather than quietly misleading.

**On what the absorbed repository was worth.** The single most valuable artifact taken is the risk scorer, not for its formula but for its discipline: deterministic, versioned, explainable, monotonic, with its invariants argued in comments beside the constants they constrain. That is unusually rare and it matches this repository's stated architecture exactly. It is worth preserving the provenance of those invariants when the code moves, so the reasoning survives the port.

**Open decisions carried forward, not resolved here.**
1. Alert rules versus escalation ladder — the intended division is stated, but the precise reconciliation is Slice 3 design work.
2. Charting library for director trend views.
3. Whether the escalation ladder becomes per-organization.
4. Timing of the absorbed repository's archival — proposed after Slice 4, not fixed.
