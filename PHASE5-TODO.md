# Phase 5 — open items (ship / deploy / extract / writeups)

Phase 5 is in progress. Deploy and demo mode are done (see PROGRESS.md); everything still
open is listed here.

## Remaining from the plan (§13 Phase 5, §11 deployment)

- **Provisioning.** The compose stack, Caddyfile and runbook exist and were rehearsed on a
  local Docker daemon; no VPS has been rented, so Let's Encrypt issuance and the public
  subdomains are unverified. Renting the host is a paid decision, deliberately left to the
  owner.
- Extract `shadow-ledger` as a standalone open-source npm library (§12.5).
- Engineering writeup + dev.to crosspost; published failure post-mortem; portfolio page;
  3-min demo video (the video is also the insurance for live-demo downtime).

## Done in Phase 5

- Deployment stack + runbook (`deploy/`, `docs/deploy.md`).
- Demo mode: read-only console, "Run a shortage", nightly idempotent re-seed, daily USD cap
  with local-model fallback (`@stopgap/demo`, `llm_spend`).

## Stubbed during this run — needs real credentials/config before Phase 5

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

## Deferred CodeRabbit findings (PR #1)

- **Audit chain is tamper-evident, not tamper-proof (CWE-345).** `packages/db/src/audit.ts`'s
  SHA-256 hash chain detects accidental corruption/bugs (verified: manually deleting a row
  makes `verifyAuditChain` correctly report the break) but anyone with DB write access can
  recompute the whole chain after editing rows — there's no secret key or external anchor.
  Phase 1's threat model is internal correctness (concurrent writers, retries), not a
  compromised DB. Before this is a real compliance control, add either a keyed HMAC (secret
  outside the DB) or anchor the chain head to an external append-only store.
- **Monitoring doesn't auto-detect feed resolution.** `pollFeedsWorkflow`/`pollAndOpenCases`
  only opens cases for `current` shortages; it never checks whether a case already in
  `monitoring` has dropped off the feed (i.e. resolved) and doesn't call `markResolved` for
  it. Today resolution requires an external caller (console action, ops script) to signal
  the case — the weekly tick just re-checks the deadline, not the feed. Wiring
  `pollAndOpenCases` to also cross-check open `monitoring` cases against the latest feed
  snapshot and signal resolution is real feature work (Phase 2/3 territory: it needs a
  feed-diff strategy, not just a poll), deferred rather than bolted on here.
- **Build gate doesn't build library packages.** `pnpm gate`'s build step only produces
  output for `apps/console` (the only package with a `build` script) — `packages/*` are
  consumed as workspace TS source directly (via `tsx`/Temporal's bundler/Next's transpiler),
  not compiled artifacts, so there's nothing for them to build in this run. Revisit if any
  package needs standalone publishing or a compiled entrypoint.

## Notes

- `.env.example` documents every variable. Copy to `.env` and fill before deploy.

## Auth (blocks several Phase 4 claims)

Stopgap has **no authentication layer**. Consequences, all recorded rather than hidden:

- Console server actions and Temporal signals are unauthenticated. The reviewer identity is a
  claim, written to the audit trail as `identitySource: workflow-signal-claim` and as the
  actor string the caller supplied — never as an asserted-verified principal.
- `review_case` on the MCP server is disabled unless `STOPGAP_MCP_ALLOW_REVIEW=1`, because an
  unauthenticated client approving a clinical protocol defeats the HITL gate.
- Per-role restrictions on which exception types a user may resolve
  (`docs/exception-matrix.md`) need this first.

Until it exists, run the console and MCP server bound to localhost only.

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
