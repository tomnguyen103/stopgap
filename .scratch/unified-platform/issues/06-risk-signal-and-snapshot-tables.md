# 06 — Risk signal and snapshot persistence

**What to build:** Normalized signals and the scores derived from them are stored per tenant, so one hospital can never read another's interpretation of the supply picture.

Note the deliberate asymmetry with existing feed storage: a feed record is one physical fact about the drug supply, identical for every hospital, and stays global. A risk signal is that fact matched and weighted against one facility, so two hospitals reading the same recall genuinely have different signals. Signals are therefore tenant-scoped.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Signals and snapshots persist as tenant tables, each carrying an organization reference and a row-level policy keyed to it
- [ ] Every read passes through the organization-scoped transaction helper
- [ ] Query helpers also carry an explicit organization predicate, so a query that loses its scope returns nothing rather than everything
- [ ] The tenant-versus-global decision and its reasoning are recorded beside each table definition
- [ ] Isolation coverage proves each new table is unreadable and unwritable from another tenant's scope, running as a role the policies actually apply to
- [ ] The scheduled feed poll, which has no organization in its context, continues to enumerate organizations and do a full pass per tenant rather than inventing one
- [ ] Migrations apply cleanly as the role a real deployment migrates as
