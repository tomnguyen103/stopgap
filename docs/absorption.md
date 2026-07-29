# Absorption record — what came across from `medical-supply-monitor`, and what did not

Stopgap is the surviving repository. `medical-supply-monitor` contributed code and design and is
archived once this record is complete; its README redirects here.

This file exists so the decision is not relitigated. A capability that was deliberately left behind
looks exactly like one that was forgotten, six months later — the difference is written down here.

## Adopted, and where it now lives

| Capability | Where it lives now | Ticket |
| --- | --- | --- |
| Normalized signal contract | `packages/ingest/src/signal.ts` | 05 |
| openFDA drug-recall and device feeds | `packages/ingest/src/openfda-recall.ts` | 05 |
| Risk-signal and score-snapshot persistence, per tenant | `packages/db/src/signals.ts`, migration 0015 | 06 |
| Deterministic, versioned, explainable scorer | `packages/scorer/` | 07 |
| Evidence artifacts behind every signal | `packages/db/src/signals.ts` (`signal_evidence`) | 09 |
| Compliance guard on generated text | `packages/compliance/` | 10 |
| Alert rules with cooldowns, and chat delivery | `packages/alerts/`, `packages/db/src/alerts.ts` | 12 |
| Daily brief | `packages/workflows/src/brief.ts` | 13 |
| Catalog schema, CSV parse and transactional import | `packages/catalog/`, `packages/db/src/catalog.ts` | 15 |
| Signal-to-catalog matching, and the dormant score components | `packages/db/src/matching.ts` | 16 |

Every adopted table carries `org_id` and a row-level-security policy, and every read goes through
the org-scoped transaction helper. The absorbed code inherits a stronger isolation guarantee than it
had — that was the point of absorbing it rather than depending on it.

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
  cannot verify, and an unverifiable signal in a clinical queue is worse than no signal.

## What is left before this repository can be called the only one

- [ ] Tickets 16 and 17 merged (this record is written, and the archive performed, after them).
- [ ] `medical-supply-monitor`'s README replaced with a redirect here.
- [ ] The source repository archived on GitHub — a decision for its owner, not for the tooling.
- [ ] `pnpm gate` green and `pnpm test:rls` passing on main at the moment of archiving.
