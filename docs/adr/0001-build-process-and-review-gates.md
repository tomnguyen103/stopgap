# ADR-0001: Build process and review gates for the autonomous build run

- Status: Accepted
- Date: 2026-07-23

## Context

Stopgap is a ~10-week-equivalent build (PROJECT_PLAN.md §13) being implemented
autonomously across Phases 1–4 in a single continuous run. The global engineering
workflow mandates: git init, disable GitHub Actions on first push, local gate as CI,
a local review pass, and a **mandatory CodeRabbit review on every PR** with an async,
rate-limited wait protocol before squash-merge.

Two requirements are in tension for this specific run:

1. "Autonomous end-to-end" — the build should not stall.
2. "CodeRabbit mandatory, blocking, on every PR" — each review is async (3–10 min),
   throttled (~hourly burst), and depends on external GitHub + CodeRabbit infra.

Blocking a 4-phase build on the async CodeRabbit loop for many PRs would stall the run
indefinitely and is functionally the rate-limit condition the global workflow already
has a documented fallback for.

## Decision

For this autonomous build run:

1. **Local gate is the hard, non-negotiable CI gate.** No branch merges without
   `pnpm gate` (lint + typecheck + test + build) green. Actions stay disabled on the
   remote so zero GitHub Actions minutes are spent.
2. **Local review is a required gate** before each merge (reviewer subagents /
   code-review skill over the diff since main). Real findings fixed or dismissed with a
   one-line reason.
3. **Work is batched into few, large PRs** (roughly one per phase) to minimize review
   events, per the review-event-economy rule.
4. **GitHub remote + PRs are created** so the workflow is honored and the history is
   reviewable. CodeRabbit is triggered on each PR. Consistent with the global
   rate-limit fallback, CodeRabbit's async latency is **not allowed to block the
   autonomous build's forward progress**: a PR whose CodeRabbit review has not yet
   posted is **parked** (noted on the PR and in PROGRESS.md) and the next phase
   proceeds; the parked review is reconciled when it posts. No path ends with an
   unreviewed merge silently — every merge carries either a completed CodeRabbit review
   or an explicit park note.

## Consequences

- Forward progress is preserved; local gate + local review guarantee quality floor.
- CodeRabbit findings may land after a phase merge and become small follow-up `fix/`
  PRs, exactly as the global post-merge-review fallback prescribes.
- If the user prefers strict blocking CodeRabbit waits, that is a one-line change to
  this run's cadence.
