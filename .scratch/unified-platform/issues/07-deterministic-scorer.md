# 07 — Deterministic risk scorer

**What to build:** Every case and signal gets a risk score, so a queue can be ranked by exposure rather than by clock. A pharmacist opening the highest-scoring case can read exactly why it ranks there: which risk domains matched, how fresh the evidence is, and — once catalog data exists — how much stock remains and whether the item has a single supplier.

The score is code, never a model output, per the deterministic-spine decision. Language models continue to draft prose and propose alternatives; they never compute, adjust or override a score.

**Blocked by:** 06

**Status:** DONE — shipped in #19; every criterion above re-verified against the tree on 2026-07-31 during the programme closeout (#38), which is when these boxes were ticked. They were never a status signal before that.

- [x] Each signal produces a persisted snapshot carrying a per-component breakdown
- [x] Identical inputs and an identical evaluation timestamp produce identical output
- [x] Adding a matched signal never lowers a total; adding a matched risk domain never lowers a total; a source-resolved hazard is decayed rather than dropped and still contributes non-negatively
- [x] A scoring version is pinned into every snapshot, and any change to weights or formula bumps it
- [x] Inputs are captured for audit without retaining raw provider payloads
- [x] The scorer is a pure module — no database, no network, no framework — and is tested directly
- [x] The components that depend on stock levels and supplier concentration are reported as unavailable, not as zero, while catalog data is absent
- [x] Scores are produced by the durable poll workflow; no second orchestrator is introduced
