# Absorption record — what came across from `medical-supply-monitor`, and what did not

Stopgap is the surviving repository. `medical-supply-monitor` contributed code and design; it is
archived once this record is complete, and its README redirects here.

This file exists so the decision is not relitigated. A capability that was deliberately left behind
looks exactly like one that was forgotten, six months later — the difference is written down here.

## Adopted, and where it now lives

| Capability | Where it lives now | Ticket |
| --- | --- | --- |
| Normalized signal contract | `packages/ingest/src/signal.ts` | 05 |
| openFDA drug-recall and device feeds | `packages/ingest/src/openfda-recall.ts` | 05 |
| Risk-signal and score-snapshot persistence, per tenant | `packages/db/src/signals.ts`, migration 0015 | 06 |
| Deterministic, versioned, explainable scorer | `packages/scorer/` | 07 |
| Evidence artifacts behind every signal | `packages/db/src/signals.ts` (`signal_evidence`), migration 0017 | 09 |
| Compliance guard on generated text | `packages/compliance/` | 10 |
| Alert rules with cooldowns, and chat delivery | `packages/alerts/`, `packages/db/src/alerts.ts` | 12 |
| Daily brief | `packages/workflows/src/brief.ts` | 13 |
| Catalog schema, CSV parse and transactional import | `packages/catalog/`, `packages/db/src/catalog.ts` | 15 |
| Signal-to-catalog matching, and the dormant score components | `packages/db/src/matching.ts` | 16 |

Every adopted table carries `org_id` and a row-level-security policy, every read goes through the
org-scoped transaction helper, and since migration 0021 every foreign key between two tenant tables
names the `(org_id, id)` PAIR rather than the child id alone. The absorbed code inherits a stronger
isolation guarantee than it had — that was the point of absorbing it rather than depending on it.

## Not adopted, with the reason

Each of these is either superseded by an existing stopgap capability with stronger guarantees, or
scope this product deliberately does not claim.

- **Hosted authentication and organization webhooks.** Superseded. Identity is Keycloak with role
  claims resolved in `apps/console/app/lib/role-claims.ts`, and tenancy is Postgres row-level
  security rather than a webhook that keeps two systems agreeing.
- **The serverless job runtime.** Superseded by Temporal. A shortage case is a long-horizon workflow
  measured in weeks; a function with a request timeout is the wrong shape for it, and the durable
  runtime is what makes "this case was never dropped" checkable rather than asserted.
- **Graph-orchestration and hosted-tracing libraries.** Superseded. Orchestration is the workflow
  package; tracing is self-hosted (`docs/observability.md`). Neither dependency earned a place in a
  deployment that has to run inside a hospital's own boundary.
- **The dashboard pages as written.** Rebuilt rather than ported (tickets 03, 08, 11, 14, 17). They
  assumed a different auth model and a different data layer; porting them would have carried both.
- **Error-reporting and managed-cache services.** Not adopted: both are third-party data egress from
  a deployment whose whole tenancy argument is that facility data stays inside it.
- **The eight non-regulatory connectors.** Not adopted. The regulatory feeds (openFDA, ASHP) are
  citable to a body a pharmacist can check; the others are aggregators whose provenance a clinician
  cannot verify, and an unverifiable signal in a clinical queue is worse than no signal. The
  contract admits them — `RISK_DOMAINS` in `packages/ingest/src/signal.ts` is deliberately short —
  so adopting one later is a data change, not a structural one.

## Adopted capabilities, confirmed working here

Ticket 20's first criterion asks for confirmation rather than assertion. Each row names the coverage
that answers it, all of which runs in `pnpm gate` or `pnpm test:rls`.

| Capability | Confirmed by |
| --- | --- |
| Signal contract | `packages/ingest/src/signal.test.ts` — normalization against recorded payloads, no network |
| Scorer | `packages/scorer/src/scorer.test.ts` — determinism, monotonicity, version pinning |
| Recall and device feeds | `packages/ingest/src/ingest.test.ts`, `packages/ingest/src/fixtures` |
| Catalog and import | `packages/catalog/src/catalog.test.ts` (pure), `packages/db/src/catalog.e2e.test.ts` (write + isolation) |
| Matching | `packages/db/src/matching.test.ts` |
| Alert rules with cooldowns | `packages/alerts/src/alerts.test.ts`, `packages/db/src/alerts.test.ts` |
| Chat delivery | `packages/workflows/src/workflow.test.ts` — delivery recorded with its outcome, never faked |
| Daily brief | `packages/workflows/src/brief.test.ts` |
| Compliance guard | `packages/compliance/src/index.test.ts` — pure, against known patterns |
| Per-tenant isolation of every adopted table | `packages/db/src/rls.e2e.test.ts`, `packages/db/src/tenant-keys.e2e.test.ts` |

## What is left before this repository can be called the only one

- [x] Tickets 16 and 17 merged — this record is written after them.
- [x] `pnpm gate` green and `pnpm test:rls` passing on the branch that lands this record.
- [ ] `medical-supply-monitor`'s README replaced with the redirect below.
- [ ] The source repository archived on GitHub.

The last two are **account-level actions on a repository this one does not own**, so they are not
performed by the change that lands this file. The replacement README is written out below rather
than described, so that performing them is copy-and-paste rather than judgement.

### The replacement README for `medical-supply-monitor`

```markdown
# medical-supply-monitor — archived

This project was absorbed into [stopgap](https://github.com/tomnguyen103/stopgap) and is no
longer maintained here. It is archived, so it is readable but takes no issues, pull requests
or commits.

Everything durable moved: the normalized signal contract, the deterministic risk scorer, the
openFDA recall and device feeds, the catalog schema and CSV import, signal-to-catalog matching,
alert rules with cooldowns, and the daily brief. All of it now runs under per-tenant Postgres
row-level security and one durable workflow runtime, which is what the move was for.

What was deliberately NOT carried across, and why, is recorded in
[`docs/absorption.md`](https://github.com/tomnguyen103/stopgap/blob/main/docs/absorption.md).
Read that before re-implementing anything from this repository — several capabilities here were
dropped on purpose rather than overlooked.
```

### Performing the archive

```bash
gh repo archive tomnguyen103/medical-supply-monitor
```

Archiving is reversible on GitHub, but the README replacement must land **before** it: an archived
repository takes no commits.
