# 20 — Archive medical-supply-monitor

**What to build:** The absorption completes. Everything worth keeping now lives in this repository under stronger tenancy, one orchestrator and one review gate. The source repository is archived so nobody maintains two pipelines by accident.

**Blocked by:** 16, 17

**Status:** ready-for-agent

- [ ] Every adopted capability is confirmed working here: the signal contract, the scorer, recall and device feeds, catalog and import, matching, alert rules with cooldowns, chat delivery, the daily brief and the compliance guard
- [ ] Capabilities deliberately not adopted are recorded with the reason, so the decision is not relitigated
- [ ] The source repository's README points here and the repository is archived
- [ ] This repository's documentation describes the combined product without referring to the absorbed repository as a live dependency
- [ ] No feature regressed during absorption — the full gate is green and the isolation tier passes
