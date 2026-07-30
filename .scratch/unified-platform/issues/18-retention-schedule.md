# 18 — Retention schedule

PR batch: A

**What to build:** The database stops growing without limit. Signals, snapshots and alert events accumulate on every poll; a scheduled job removes what is past its retention window, so a long-running deployment does not slowly degrade.

**Blocked by:** 06, 15

**Status:** ready-for-agent

- [ ] A scheduled job removes records past their retention window across the high-volume tables
- [ ] Retention windows are configurable per record type
- [ ] Cleanup is tenant-scoped and cannot remove another tenant's rows
- [ ] Audit chain integrity survives cleanup — anchored history is never orphaned or broken
- [ ] A cleanup run is recorded, so it is visible whether it ran and what it removed
- [ ] The job runs on the durable workflow runtime; no second orchestrator is introduced
- [ ] A cleanup interrupted midway leaves the database consistent
