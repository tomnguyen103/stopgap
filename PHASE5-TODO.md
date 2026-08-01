# Phase 5 — closeout and owner-controlled items

The repo-controlled Phase 5 work is complete and merged. Deployment rehearsal, demo mode,
`shadow-ledger` extraction, the writeup, post-mortem and portfolio copy are delivered in the
repository; only the owner-controlled release/deployment actions below remain.

## Remaining owner actions from the plan (§13 Phase 5, §11 deployment)

- **Provisioning.** The compose stack, Caddyfile and runbook exist and were rehearsed on a
  local Docker daemon; no VPS has been rented, so Let's Encrypt issuance and the public
  subdomains are unverified. Renting the host is a paid decision, deliberately left to the
  owner.
- Publish `shadow-ledger` to npm and split it into its own pinned repository (§12.5). The
  library is extracted, built and consumed in-workspace; publishing is a release decision
  left to the owner (`packages/shadow-ledger/PUBLISHING.md`).
- **Publishing** the writeup and post-mortem (dev.to crosspost), putting the portfolio copy
  on tomnguyen.me, and recording the 3-minute demo video. All three documents are written
  (`docs/writeup.md`, `docs/post-mortem.md`, `docs/portfolio.md`, the last containing the
  video outline); pushing them to public channels is the owner's call, not an agent's.

No item in this section authorizes the agent to rent hosting, publish to an account, or send
public communications. These are release decisions, not implementation gaps.

## Done in Phase 5

- Deployment stack + runbook (`deploy/`, `docs/deploy.md`).
- `shadow-ledger` extraction: standalone dependency-free library, `@stopgap/shadow` reduced
  to an adapter over it.
- Demo mode: read-only console, "Run a shortage", nightly idempotent re-seed, live-feed
  freshness panel, daily USD cap with local-model fallback (`@stopgap/demo`,
  `@stopgap/observability` spend cap, `llm_spend`, `demo_runs`).

## Resolved repo-side closeout decisions

- **Measured demo shadow rows are now populated by the nightly service.** The seed still writes
  only cases and protocols, never invented agreement percentages. In demo mode, `demo-seed`
  runs the real `@stopgap/shadow replay` after the idempotent seed; the replay writes measured
  rows and remains observational. Migration `0024_icy_barracuda.sql` makes a corpus entry
  idempotent per UTC day while preserving duplicate legacy evidence. The runbook's manual replay
  command is retained as a backfill.
- **Scenario limits are now per anonymous visitor plus an aggregate demo bound.**
  `startDemoShortage` issues a server-generated httpOnly visitor UUID cookie, `demo_runs` stores it,
  and the reservation advisory lock/count enforce both `(org_id, visitor_id)` and the aggregate
  `(org_id)` hourly limits. Clearing the cookie cannot bypass `DEMO_MAX_RUNS_PER_HOUR_TOTAL`; the
  optional daily LLM spend cap remains an additional hard deployment boundary.
- **The Ollama image has a local runtime receipt; full deployment fallback remains follow-up.**
  `ollama/ollama:0.5.7` started on CPU against the local model store, exposed the cached models,
  and generated a response from `mistral:latest`. The provider tests cover the budget switch, but
  the full production Compose network plus over-cap request path still belongs to the VPS/runtime
  rehearsal, not a missing repository implementation.

## External/configuration follow-up (owner-controlled)

These integrations are implemented in the repository. They remain unconfigured in this local
environment and need deployment credentials or provider accounts before provider-specific live
claims can be made; they are not missing repo work.

- **`GEMINI_API_KEY` absent.** The Gemini provider is implemented but not exercised
  against the live API. Local gate + CI run on Ollama. Set the key and run the
  Gemini-vs-Ollama eval to produce the comparison table with real numbers.
- **`RESEND_API_KEY` absent.** Outbound email records a non-delivery with the reason
  "RESEND_API_KEY not configured" in the audit trail — it does not fall back to a fake
  transport, because a stub reporting success would make "we told the floor" unfalsifiable.
  Set the key plus `COMMS_PHARMACY_TO` (or `COMMS_DEMO_INBOX`) to send for real.
- **Langfuse keys absent.** Self-hosted Langfuse is wired via OTel; without both keys tracing
  is off entirely (no exporter, no flush timer). `docker compose --profile langfuse up -d`
  seeds a local project and its key pair.
- **openFDA API key absent (optional).** Polling works unauthenticated at a lower rate
  limit; add `OPENFDA_API_KEY` for higher throughput.
- **`ASHP_AUTH_KEY` absent.** `pollAshp()` returns `[]` (see `ashpStubbed()`) so the ASHP
  feed contributes nothing to `pollFeedsWorkflow`/`pollAndOpenCases` in this run — only
  openFDA opens cases live. ASHP mappers are unit-tested against a recorded fixture.
  Set `ASHP_AUTH_KEY` for ASHP to actually poll and merge into the dedup/auto-open path.

## Historical deferred CodeRabbit findings (PR #1; closed by Phase 6)

- **Closed in Phase 6 PR #6 — the audit-chain limitation was resolved.** The old SHA-256-only
  chain in `packages/db/src/audit.ts` is now protected by versioned HMAC rows, and the anchor
  activities/routes plus `verifyAnchors` compare the head with an append-only external anchor.
  See the current implementation and receipts in `PROGRESS.md`.
- **Closed in Phase 6 PR #6 — feed resolution is now detected by monitoring.**
  `pollFeedsWorkflow`/`pollAndOpenCases` now use consecutive feed misses or an explicit resolved
  status to auto-resolve monitoring cases, record audit evidence, and reopen cases when a feed key
  reappears. See `packages/workflows/src/activities.ts` and `PROGRESS.md` for the current
  implementation.
- **Build gate builds only the packages that have a build.** `pnpm gate`'s build step
  produces output for `apps/console` and `shadow-ledger` (the publishable library) — `packages/*` are
  consumed as workspace TS source directly (via `tsx`/Temporal's bundler/Next's transpiler),
  not compiled artifacts, so there's nothing for them to build in this run. Revisit if any
  package needs standalone publishing or a compiled entrypoint.

## Notes

- `.env.example` documents every variable. Copy to `.env` and fill before deploy.

## Historical auth note (closed by Phase 6)

Before Phase 6, Stopgap had **no authentication layer**. The historical consequences were:

- Console server actions and Temporal signals are unauthenticated. The reviewer identity is a
  claim, written to the audit trail as `identitySource: workflow-signal-claim` and as the
  actor string the caller supplied — never as an asserted-verified principal.
- `review_case` on the MCP server was disabled unless `STOPGAP_MCP_ALLOW_REVIEW=1`, because an
  unauthenticated client approving a clinical protocol defeats the HITL gate. **Closed in Phase 6
  §6.7:** the env gate is gone; the MCP server now reaches Stopgap through the public REST API with
  a scoped API key, so review requires a key an administrator issued with `protocols:write` — and
  the decision lands in the audit chain attributed to that key and its issuer.
- Per-role restrictions on which exception types a user may resolve
  (`docs/exception-matrix.md`) need this first.

Phase 6 PR #7 adds Keycloak OIDC/RBAC and PR #9 moves programmatic review behind scoped API
keys. Current auth/browser evidence is recorded in `PROGRESS.md` and
`docs/coverage-ledger-2026-08-01.md`; the historical localhost-only instruction no longer
describes the merged repository.

## Phase 3 deferrals

- **Shadow-ledger cost attribution.** `shadow_runs.usd_cost` is written as `0`, which is the
  true cost of a local-Ollama replay but would be wrong for a paid provider. Real attribution
  needs per-call token counts routed from the provider telemetry sink into the run record
  (they already exist in the Langfuse span). Until then the per-class cost aggregate on
  `/shadow` is only meaningful for local runs.
- **Per-call provider attribution in shadow runs.** `runShadowEntry` resolves the route once
  and records that; a failover happening inside one of the two agent calls is not reflected in
  the ledger row. The per-call truth is in the OTel spans.
- **Per-case Langfuse traces.** Spans are emitted per LLM call, not grouped into one trace per
  shortage case — that needs the Temporal workflow id propagated into the activity context.
