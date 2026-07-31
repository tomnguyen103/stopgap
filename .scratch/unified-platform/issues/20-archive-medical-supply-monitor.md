# 20 — Archive medical-supply-monitor

**What to build:** The absorption completes. Everything worth keeping now lives in this repository under stronger tenancy, one orchestrator and one review gate. The source repository is archived so nobody maintains two pipelines by accident.

**Blocked by:** 16, 17

**Status:** DONE in this repository; the archive itself is handed to the repository owner.

The absorption record landed as `docs/absorption.md`, which also carries the replacement README for
`medical-supply-monitor` verbatim and the `gh repo archive` command. Replacing that README and
flipping the archive switch are account-level actions on a repository this one does not own, so they
were deliberately NOT performed by the change that landed the record — the owner performs them.

- [x] Every adopted capability is confirmed working here: the signal contract, the scorer, recall and device feeds, catalog and import, matching, alert rules with cooldowns, chat delivery, the daily brief and the compliance guard
- [x] Capabilities deliberately not adopted are recorded with the reason, so the decision is not relitigated
- [ ] The source repository's README points here and the repository is archived — **prepared, not performed.** The replacement README and the archive command are in `docs/absorption.md`; both act on another repository and are the owner's to run.
- [x] This repository's documentation describes the combined product without referring to the absorbed repository as a live dependency
- [x] No feature regressed during absorption — the full gate is green and the isolation tier passes
