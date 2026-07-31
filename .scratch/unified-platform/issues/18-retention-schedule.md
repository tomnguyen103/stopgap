# 18 — Retention schedule

PR batch: A

**What to build:** The database stops growing without limit. Signals, snapshots and alert events accumulate on every poll; a scheduled job removes what is past its retention window, so a long-running deployment does not slowly degrade.

**Blocked by:** 06, 15

**Status:** DONE — shipped in #15 (batch A); every criterion above re-verified against the tree on 2026-07-31 during the programme closeout (#38), which is when these boxes were ticked. They were never a status signal before that.

- [x] A scheduled job removes records past their retention window across the high-volume tables
- [x] Retention windows are configurable per record type
- [x] Cleanup is tenant-scoped and cannot remove another tenant's rows
- [x] Audit chain integrity survives cleanup — anchored history is never orphaned or broken
- [x] A cleanup run is recorded, so it is visible whether it ran and what it removed
- [x] The job runs on the durable workflow runtime; no second orchestrator is introduced
- [x] A cleanup interrupted midway leaves the database consistent
