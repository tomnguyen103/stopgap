# 09 — Evidence artifacts

**What to build:** The evidence behind a signal is retained and retrievable, so a pharmacist can verify a claim themselves rather than taking the system's word for it. Every signal can be traced back to the source record that produced it.

**Blocked by:** 06

**Status:** ready-for-agent

- [ ] Evidence persists per signal as a tenant table with an organization reference and a row-level policy
- [ ] Each artifact records its type, its origin, and when it was captured
- [ ] Evidence is retrievable for a given signal and links to the originating source record
- [ ] Retention captures what is needed for audit without storing content that could carry protected information
- [ ] Isolation coverage proves the table is unreadable from another tenant's scope
