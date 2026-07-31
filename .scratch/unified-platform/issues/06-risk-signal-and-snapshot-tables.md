# 06 — Risk signal and snapshot persistence

**What to build:** Normalized signals and the scores derived from them are stored per tenant, so one hospital can never read another's interpretation of the supply picture.

Note the deliberate asymmetry with existing feed storage: a feed record is one physical fact about the drug supply, identical for every hospital, and stays global. A risk signal is that fact matched and weighted against one facility, so two hospitals reading the same recall genuinely have different signals. Signals are therefore tenant-scoped.

**Blocked by:** 05

**Status:** DONE — shipped in #18; every criterion above re-verified against the tree on 2026-07-31 during the programme closeout (#38), which is when these boxes were ticked. They were never a status signal before that.

- [x] Signals and snapshots persist as tenant tables, each carrying an organization reference and a row-level policy keyed to it
- [x] Every read passes through the organization-scoped transaction helper
- [x] Query helpers also carry an explicit organization predicate, so a query that loses its scope returns nothing rather than everything
- [x] The tenant-versus-global decision and its reasoning are recorded beside each table definition
- [x] Isolation coverage proves each new table is unreadable and unwritable from another tenant's scope, running as a role the policies actually apply to
- [x] The scheduled feed poll, which has no organization in its context, continues to enumerate organizations and do a full pass per tenant rather than inventing one
- [x] Migrations apply cleanly as the role a real deployment migrates as
