# Phase 6 — Production hardening: from demo to deployable internal software

**Status:** planned (2026-07-24). Nothing in this file is built yet.
**Goal:** evolve Stopgap from portfolio demo into something shaped like real internal
hospital software — authenticated, tamper-proof, observable, lifecycle-complete.
**Source of truth for what exists today:** `PROGRESS.md`, `PHASE5-TODO.md`.

Ordering rule: identity (6.1) unblocks 6.3/6.5/6.7. 6.2 and 6.6 are independent and
may land first. Recommended PR sequence: **6.2 → 6.6 → 6.1 → 6.3 → 6.4 → 6.7 → 6.5**.

Every item ships through the standard workflow: branch off fresh main, local gate
(`pnpm gate`) green, local review, PR, CodeRabbit wait protocol, squash-merge. Batch
related items into one PR where sensible (6.2+6.6 pair well as "close the deferred
findings" PR).

---

## 6.1 RBAC + OIDC SSO, wired into the audit chain

**Motivation.** `audit_log.actor` and `protocol_versions.approved_by` are free-text
strings; console server actions in `apps/console/app/lib/actions.ts` are ungated —
anyone who can reach the console can approve a substitution protocol. Internal hospital
software without authn/z is not deployable, and approval provenance ("who authorized
this") is the compliance question a text field cannot answer.

**Build.**
- Auth.js (NextAuth v5) in `apps/console`, OIDC provider abstraction. Add a Keycloak
  container to the compose stacks (dev + `deploy/docker-compose.prod.yml`) as the
  default IdP; config is a URL swap to Azure AD/Okta in a real deployment. Seed a
  realm + demo users via Keycloak import JSON so `docker compose up` is enough.
- New tables (Drizzle, `packages/db/src/schema.ts` + migration): `users` (id uuid,
  oidc subject, email, display name, created/disabled), `roles` (enum-like:
  `viewer`, `pharmacist`, `pharmacy_director`, `admin`), `user_roles` (user_id,
  role, unique pair).
- Authorization guards: a `requireRole(role)` helper used at the top of every server
  action; per-action matrix — pharmacist may resolve exceptions and acknowledge,
  pharmacy_director may approve/supersede protocol versions, admin may manage users,
  spend caps, demo config; viewer is read-only. Middleware protects all console
  routes; demo mode maps to an anonymous `viewer` session so the public demo still
  works read-only.
- Identity into the audit chain: `audit_log.actor` and `protocol_versions.approved_by`
  / `authored_by` become FKs to `users.id` (keep a text `actor_label` for the
  migration of historical rows; backfill legacy values as a synthetic `system` /
  `agent` user). Every audit append and protocol approval must carry the
  authenticated user id from the session — never a client-supplied string.
- Tests: guard unit tests per role x action; an integration test proving a
  pharmacist session cannot approve a protocol version (server-enforced, not just
  hidden UI).

**Acceptance.**
- Unauthenticated request to any console route redirects to Keycloak login (demo
  mode excepted, read-only).
- Role matrix enforced server-side; test proves privilege escalation fails.
- New audit rows carry a real `users.id`; chain verification still passes across
  the migration boundary.

**Estimate:** 3–5 days.

## 6.2 Audit chain: keyed HMAC + external anchoring + verification UI

**Motivation.** Recorded CodeRabbit finding (CWE-345, `PHASE5-TODO.md`): the SHA-256
chain in `packages/db/src/audit.ts` is tamper-evident, not tamper-proof — anyone with
DB write access can recompute the whole chain. HMAC with a key outside the DB plus an
external anchor closes it.

**Build.**
- Switch row hash to HMAC-SHA256, key from `AUDIT_HMAC_KEY` env (document KMS as the
  production home). Versioned scheme field (`v1` plain / `v2` hmac) so old rows still
  verify; `verifyAuditChain` handles the boundary.
- Anchoring: hourly Temporal schedule (reuse the `pollFeedsWorkflow` schedule
  pattern) running an `anchorAuditChain` activity: write `(ts, max_audit_id, head
  hash)` to an append-only anchor. Pluggable sink: default local append-only file
  under a Docker volume; optional RFC 3161 timestamp authority (e.g. freetsa) behind
  `AUDIT_TSA_URL`. New `audit_anchors` table mirrors what was anchored for the UI.
- Verification UI: admin console page `Audit integrity` — runs chain verification +
  compares stored anchors vs recomputed heads; green/red per segment, names the
  first broken row. CLI `pnpm verify-audit` for headless use.
- Demo script (docs): tamper a row in psql, watch the page flip red with the exact
  segment named.

**Acceptance.**
- Editing any historical row (payload, actor, ts) makes verification fail and the
  UI/CLI name the segment.
- Recomputing the chain without `AUDIT_HMAC_KEY` cannot produce valid rows.
- Anchors accumulate hourly; verification cross-checks them.

**Estimate:** 1.5–2.5 days.

## 6.3 Escalation engine with acknowledgment tracking

**Motivation.** Critical shortages currently notify once; nobody tracks whether a
human saw it. Ops systems live on "did someone ack." Also the single best showcase of
why Temporal is in the stack (durable timers survive worker death).

**Build.** *(depends on 6.1 for user identity)*
- `escalation_policies` table: per-severity ladder as jsonb steps
  `[{afterMinutes, notify: role|channel}]`, editable in admin UI; seed defaults
  (critical: 0min pharmacist, 30min pharmacy_director, 60min admin/broadcast).
- Case workflow extension (`packages/workflows`): after a critical/high case opens
  (or severity escalates), run an escalation child loop — send step notification via
  existing `@stopgap/comms`, then `condition(acked, timeout)`; on timeout advance to
  next step. Ack arrives as a Temporal signal from a console server action
  (`acknowledgeCase`), recorded in `acknowledgments` table (case_id, user_id, ts,
  step) and audit-logged.
- Console: per-case escalation timeline (notified → unacked → escalated → acked by
  whom), ack button gated to pharmacist+.
- Non-delivery honesty preserved: a failed send records non-delivery (existing
  comms stance) and still advances the ladder.
- Tests: time-skipped Temporal test — open critical case, no ack, ladder advances
  through all steps; ack mid-ladder stops it; worker restart mid-timer resumes
  correctly (kill/restart in the time-skip harness).

**Acceptance.**
- Time-skip test proves ladder + ack + resume-after-restart.
- Every notification, non-delivery, and ack lands in the audit chain with user id.

**Estimate:** 3–4 days.

## 6.4 Ops observability: metrics, alerting, SLOs

**Motivation.** LLM calls are traced (Langfuse/OTel) but the app itself has no health
story — no metrics, no alerts, no health endpoints. "How do you know it's up?" is the
first internal-platform question.

**Build.**
- OTel metrics from worker + console via `@stopgap/observability`: cases opened/day,
  exception queue depth, feed poll success + staleness seconds per source, comms
  delivery/non-delivery counts, ack latency, LLM daily spend vs cap, workflow task
  failures.
- Compose additions (dev + prod): Prometheus (+ otel-collector prometheus exporter),
  Grafana with two provisioned dashboards checked into `deploy/grafana/` — **Ops**
  (feed freshness, worker liveness, queue depth, task failures) and **Business KPI**
  (§14 targets as SLOs: time-to-protocol p95, agreement %, under-escalation rate);
  Alertmanager with rules: any feed stale > 45min, worker down > 2min, spend > 80%
  cap, critical case unacked > policy limit.
- `/healthz` (liveness) + `/readyz` (DB + Temporal reachable) on console and a tiny
  HTTP sidecar on the worker; wire compose healthchecks to them.
- Docs: `docs/observability.md` — what each alert means, first-response runbook.

**Acceptance.**
- `docker compose up` brings Grafana with both dashboards populated from live
  metrics, no manual clicking.
- Stopping the feed poller fires the staleness alert; killing the worker flips
  `/readyz` and the liveness alert.

**Estimate:** 2–3 days.

## 6.5 Multi-tenancy: hospital organizations with Postgres RLS

**Motivation.** Single-hospital tool → platform a health system deploys across
facilities. Isolation enforced in Postgres itself (RLS), not WHERE clauses, so an
app-layer bug cannot leak cross-tenant.

**Build.** *(depends on 6.1; largest item; last)*
- `organizations` table; `org_id` FK on cases, protocols, protocol_versions,
  shadow_runs, audit_log, users (and demo_runs). Migration assigns existing rows to
  a seed org.
- RLS policies on every tenant table keyed to `current_setting('app.current_org')`;
  Drizzle connection wrapper sets it per-request from the session's org. A dedicated
  migration/maintenance role bypasses RLS explicitly.
- Temporal: workflow ids become `org-<orgId>-case-<key>`; schedules run per-org or
  carry org context through activities.
- Console: org picker for multi-org admins; all queries flow through the RLS-scoped
  connection.
- Audit chain becomes per-org (chain heads per org_id) so one org's verification
  never reads another's rows.
- Tests: RLS integration test — session scoped to org A selects/updates org B rows,
  gets zero rows / permission denied. Cross-tenant leak test on every tenant table.

**Acceptance.**
- Failed cross-tenant query demonstrable in psql with the policy SQL shown.
- Two seeded orgs run side by side; cases, protocols, shadow, audit fully disjoint.

**Estimate:** 5–8 days.

## 6.6 Feed-resolution auto-detect

**Motivation.** Second recorded deferred finding: the system opens cases
automatically but never notices a shortage ended — resolution needs an external
caller. Close the lifecycle loop.

**Build.**
- In `pollAndOpenCases` (packages/workflows): after ingesting a snapshot, diff open
  `monitoring` cases against current-shortage keys. Key absent → increment a
  `feedMissCount` on the case row; present → reset to 0. At N consecutive misses
  (default 3, env-configurable) signal `markResolved` with an audit entry citing the
  evidence: source, last-seen source_id, the poll timestamps of the misses.
- Per-source trust: an explicit openFDA `resolved` status resolves immediately
  (miss-counting is only for absence); ASHP (stubbed) follows the same interface.
- Flap protection: a key reappearing after resolution reopens per the existing
  recurrence path (Phase 3) — new run, same case row; test this.
- Tests: unit tests for the diff + miss-counter; time-skip workflow test for
  absent → resolved → reappears → reopened.

**Acceptance.**
- Simulated feed dropping a monitored key resolves the case after N polls with
  evidence in the audit log; single-poll flap does not resolve.

**Estimate:** 1.5–2 days.

## 6.7 Public API with scoped keys + OpenAPI

**Motivation.** Internal platforms get integrated (EHR, BI, bots). Today the only
programmatic surface is the stdio MCP server with its own ad-hoc gating.

**Build.** *(depends on 6.1 conceptually — key scopes mirror roles)*
- `apps/api` (Hono, or Next route handlers under `apps/console/app/api/v1` to avoid
  a new deployable — decide at implementation; prefer route handlers for compose
  simplicity): REST over cases (list/get), protocols (list/get/versions),
  shadow aggregates; write endpoints (resolve exception, approve version) mirror the
  6.1 role matrix via key scopes.
- `api_keys` table: hashed key (store SHA-256, show plaintext once), scopes
  (`cases:read`, `protocols:read`, `protocols:write`, `shadow:read`), per-key
  rate limit (reuse the `demo_runs` sliding-window pattern), last_used_at,
  revoked_at. Admin UI: issue/revoke, scope picker.
- OpenAPI 3.1 spec generated from the existing Zod schemas (`@stopgap/agents`,
  new request/response schemas) via `zod-openapi`; serve Swagger UI at
  `/api/v1/docs` (admin or viewer-gated).
- Refactor the MCP server (`packages/mcp`) to call this API with a key instead of
  touching the DB directly — one authorization path for all programmatic access.
- Tests: scope enforcement (read key cannot write), rate-limit, revoked key 401,
  MCP-through-API integration.

**Acceptance.**
- Swagger UI works against the live stack; MCP server functions with only an API
  key, no direct DB access; scope matrix covered by tests.

**Estimate:** 3–4 days.

---

## Cross-cutting rules

- **No fake success.** Missing keys/IdP/TSA record honest non-configuration, same
  stance as comms non-delivery. Demo mode stays functional throughout (read-only
  viewer session).
- **Migrations are additive and reversible**; each PR's migration runs against a
  seeded Phase 5 database in a test before merge.
- **Every new privileged action lands in the audit chain** with the authenticated
  identity.
- Gate stays hard (`pnpm gate`); eval stays a signal, not a gate.
- Update `PROGRESS.md` (phase status + Merged-PR log line) and this file's checkboxes
  as items merge.

## Progress

- [x] 6.2 Audit HMAC + anchoring + verification UI (PR #6)
- [x] 6.6 Feed-resolution auto-detect (PR #6)
- [x] 6.1 RBAC + OIDC SSO (PR #7)
- [ ] 6.3 Escalation + acknowledgment
- [ ] 6.4 Observability: metrics, alerting, SLOs
- [ ] 6.7 Public API + scoped keys + OpenAPI
- [ ] 6.5 Multi-tenancy with RLS
