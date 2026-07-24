# shadow-ledger

Run an agent in shadow mode: score what it *would have done* against what a human actually
did, aggregate per cohort, and let it earn autonomy from measured agreement instead of from a
demo that went well.

Zero dependencies. Storage-agnostic. Extracted from
[Stopgap](https://github.com/tomnguyen103/stopgap), a hospital drug-shortage response
platform, where it decides how much work an agent may do before a pharmacist looks.

```bash
npm install shadow-ledger
```

## The idea

An agent that is right 80% of the time is not 80% ready to act alone — it depends *which* 20%
it gets wrong, and on which inputs. Shadow mode answers that: the agent runs on real inputs,
its judgement is scored against the human baseline, and nothing it produces reaches anyone.
When a cohort's numbers clear a bar, that cohort — and only that cohort — moves up a stage.

Three stages: `shadow` (scored, invisible) → `suggest` (shown to a human first) →
`autonomous` (acts first, human checks after).

## Usage

```ts
import { createScale, ShadowLedger, evaluatePromotion } from "shadow-ledger";

const severity = createScale(["none", "low", "moderate", "high", "critical"] as const);
const ledger = new ShadowLedger(severity);

await ledger.record({
  inputId: "case-4471",
  cohort: "anticoagulant",          // gates are per cohort, never global
  proposal: { level: "moderate", hasOutcome: true },   // what the agent said
  baseline: { level: "critical", hasOutcome: true },   // what the human said
});

const stats = await ledger.statsFor("anticoagulant");
const decision = evaluatePromotion(stats);

decision.stage;      // "shadow"
decision.blockedBy;  // ["needs 20 scored runs (has 1)", "needs level agreement 0.85 (has 0.00)"]
```

## What it scores, and what it does not

Two axes, chosen because they are the two a human labels cheaply and honestly:

- an ordinal **level** — severity, risk, priority;
- a boolean **outcome** — was there an answer at all (a substitute, a match, a fix).

It does **not** score whether the agent picked the same specific answer as the human. That
needs a label nobody produces at scale, and faking it makes the number look precise while
measuring nothing.

The two directions of a level miss are tracked separately. Over-calling costs review time;
under-calling lets something through. `underCallRate` has its own ceiling in the gates,
stricter than the overall agreement bar.

## Gates

`DEFAULT_GATES` is a starting point, not a recommendation for your domain:

| | `suggest` | `autonomous` |
|---|---|---|
| scored runs | 20 | 50 |
| mean agreement | 0.80 | 0.90 |
| level agreement | 0.85 | 0.95 |
| under-call rate | ≤ 0.05 | ≤ 0.01 |

Pass your own as the second argument to `evaluatePromotion`. A decision always carries
`blockedBy` in words: a gate that only says "no" teaches nobody what would change the answer.

## Storage

`ShadowStore` is an interface with an in-memory implementation for tests and batch runs. Any
real deployment already has a database and wants these rows in it, next to the records they
are about — implement `append` / `byCohort` / `cohorts` against yours.

## What promotion does not buy

In Stopgap, even at the top stage every protocol still passes a mandatory human approval gate.
The stages control how much work the agent does *before* a human looks, never *whether* one
does. Whether that holds in your system is your design decision — this library measures
agreement and reports a stage; it does not enforce what the stage means.

## License

MIT
