# Exception matrix

Every path where Stopgap stops and asks a human, why it stops there, and how the case gets
moving again. This is the contract behind PROJECT_PLAN §8's "under-escalation ≈ 0": the agent
is allowed to be wrong, but it is not allowed to be quietly wrong.

A case in `exception` is **parked, not failed** — it waits for a pharmacist for up to the
monitoring horizon (90 days), and the resolution becomes an approved protocol version, so the
same shortage never costs a second escalation.

| Exception reason | Trigger | Why a human | Resolution path | What it produces |
|---|---|---|---|---|
| `low-confidence-impact` | `assessImpact` returns `confidence < 0.5` | A shaky severity call is as dangerous as a shaky substitution — and the research call would build on it | Console → *Resolve exception*, or `exceptionResolved` signal | Approved protocol version, case continues to comms |
| `no-therapeutic-equivalent` | Alternatives agent returns an empty list | Plasma-derived products, specific antidotes and single-source oncology agents have no substitute; the answer is allocation policy, not a swap | Same | Same |
| `missing-protocol-draft` | Alternatives exist but the draft text is empty | The review gate would otherwise show a pharmacist nothing to approve | Same | Same |
| `low-confidence-alternatives` | `researchAlternatives` returns `confidence < 0.5` | An unsure substitution recommendation is the failure mode that reaches a patient | Same | Same |
| `monitoring-timeout` | 90 days in `monitoring` with no resolution signal | A shortage nobody closed is the "dropped case" this platform exists to prevent | Investigate the feed, then resolve or close the case | Case leaves the open set |
| *(rejected)* | Pharmacist rejects the draft at review | Explicit human refusal, with a required reason | Terminal — reopen requires a new case | Rejection reason in the audit trail |

## Escalation rules that are not exceptions

- **Reused protocol still goes through review.** A memory hit skips the research call, not the
  pharmacist. Promotion stages (shadow → suggest → auto-draft) change how much work happens
  before a human looks, never whether one looks.
- **Comms non-delivery does not park the case.** A missing `RESEND_API_KEY` or an unreachable
  EHR webhook is recorded in the audit trail as a non-delivery with a reason; the case
  continues to monitoring. Blocking a clinical case on an email transport would be worse than
  the missed email.
- **Feed poisoning does not escalate by itself.** Prompt-injection defenses (delimiter,
  escaping, untrusted-data notice) aim to make the injected text inert; if an attack does
  steer the output, the confidence and no-equivalent gates above are the backstop, not a
  dedicated "injection detected" path. See `packages/agents/src/injection.eval.ts` for the
  measured limits of that defense on a small local model.

## Who resolves what

There is no role model yet — the console records the reviewer as a claimed identity
(`identitySource: workflow-signal-claim` in the audit trail) because Stopgap has no
authentication layer. Verified principals, and per-role restrictions on which exception types
a given user may resolve, are tracked in `PHASE5-TODO.md`.
