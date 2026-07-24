# Provider comparison — Gemini vs local Ollama

PROJECT_PLAN §4 asks for a measured provider-portability table: one agent layer, two
providers, honest trade-offs. Half of it exists today.

## Status

**The Ollama column is measured. The Gemini column is empty because this build has no
`GEMINI_API_KEY`** — the provider registry treats Gemini as stubbed and every run routes to
local Ollama. Nothing here is estimated or copied from a vendor benchmark; an empty cell means
not measured.

## Measured: `mistral` (7B, local, temperature 0)

| Dimension | Result | Source |
|---|---|---|
| Golden-dataset pass rate | 80–84% (71/89 and 75/89 on two full runs) | `pnpm eval:full` |
| Run-to-run variance | ~4 points on an identical corpus | two consecutive full runs |
| Injection suite | 6/7 attack classes resisted; direct severity-override still lands some runs | `packages/agents/src/injection.eval.ts` |
| Latency per agent call | 1.5–9 s (median ≈ 4 s) | shadow ledger `latency_ms` |
| Cost | $0 | local inference |
| Structured-output reliability | Needs normalization: the model reports confidence as 0–100 often enough that the schema coerces it (`packages/agents/src/schemas.ts`) | live runs |

### Where the local model is weakest

1. **No-equivalent drugs** — invents a substitute for plasma-derived products, single-source
   oncology agents and antidotes. Under-escalation direction, so the confidence and
   no-equivalent gates carry the safety load.
2. **Resolved shortages** — over-escalates a shortage that has already cleared.
3. **Direct instruction override** — a feed note demanding `severity="critical"` still lands
   some runs, unlike the subtler attack classes which are consistently resisted.

## Reproducing the Gemini column

With a key in `.env`:

```bash
LLM_PROVIDER=gemini pnpm eval:full
```

Then record the same six rows plus the three weakness checks. The agent code needs no change —
that is the point of the provider registry (ADR-0002). Until then this gap is tracked in
`PHASE5-TODO.md`.
