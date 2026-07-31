# 11 — Pharmacist dashboard

PR batch: B

**What to build:** The pharmacist's working surface. They sign in and their review queue is already in front of them, ranked by risk rather than by age, filterable and sortable so they can work through one category at a time. Opening a case shows the drafted protocol beside the evidence that produced it and the alternatives with their stated confidence, so the judgement can be made without leaving the page. They approve, edit or reject — and an edit is recorded as distinct from a plain approval, because the audit trail should reflect what actually happened.

**Blocked by:** 03, 07, 09, 10

**Status:** DONE — shipped in #34 (batch B); every criterion above re-verified against the tree on 2026-07-31 during the programme closeout (#38), which is when these boxes were ticked. They were never a status signal before that.

- [x] The pharmacist lands on their review queue, ranked by risk score
- [x] The queue can be filtered by severity, status and risk domain, sorted, searched and paged, with state carried in the page address
- [x] A case shows its drafted protocol alongside the evidence, with evidence opening in a drawer rather than a page load
- [x] Proposed alternatives show the model's stated confidence
- [x] A case whose confidence fell below the routing threshold appears in the exception queue rather than as a confident draft
- [x] Approve, edit and reject all work, and an edit is recorded distinctly from an approval
- [x] An exception-queue case can be resolved
- [x] Generated text is screened by the compliance guard before it renders
- [x] Controls for actions above the pharmacist role render disabled and name the required role
- [x] Every decision is written into the tamper-evident audit chain with the acting user's identity
