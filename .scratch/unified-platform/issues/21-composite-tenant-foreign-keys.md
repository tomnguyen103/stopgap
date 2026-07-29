# 21 — Composite tenant foreign keys, everywhere a tenant row points at another

**What to build:** Every foreign key between two tenant tables names the `(org_id, id)` PAIR, not the child id alone, so a row filed under one hospital cannot point at another hospital's row.

A plain foreign key proves the parent exists; it does not prove it belongs to this tenant. The referential check runs with row-level security bypassed, and `org_id` is written by the calling function, so a row naming another tenant's parent passes both the foreign key and the policy's `WITH CHECK` and lands. Requiring the pair to match makes that unrepresentable in the database instead of a rule every future caller has to remember.

Three tables already do this and are the pattern to copy: `risk_score_snapshots` and `signal_evidence` reference `risk_signals (org_id, id)`, and `alert_events` references `alert_rules (org_id, id)`. Each needs a unique constraint over exactly the referenced pair on the parent — `risk_signals_org_id_uq` is that constraint, and it exists solely to make the pair a legal foreign-key target.

What is still plain: `acknowledgments.case_id` and `audit_log.case_id` both reference `cases.id` on its own. Both are tenant tables carrying their own `org_id`, so both can currently hold a row whose org and whose case disagree.

**Blocked by:** nothing technically — but it adds a migration, and every branch in the ticket queue already carries one. Land it after tickets 01–20 have merged, so the numbering is settled and the schema merge is against a quiet main.

**Status:** ready-for-agent, queued behind the ticket queue

- [ ] `cases` gains a unique constraint over `(org_id, id)`, with the same note the one on `risk_signals` carries: redundant as an index, required by Postgres before the pair can be a foreign-key target
- [ ] `acknowledgments` and `audit_log` reference `cases (org_id, id)` as a composite foreign key, replacing the plain reference to `cases.id`
- [ ] The delete behaviour of each converted key is stated deliberately rather than inherited — an audit entry must not disappear because a case did
- [ ] Any tenant table landing from the catalog and matching tickets follows the same rule, including rows that reference `risk_signals`
- [ ] Isolation coverage proves the database REFUSES a row whose `org_id` and parent disagree, running as the application role the policies apply to — not as the owner, which bypasses them
- [ ] The migration applies cleanly as the role a real deployment migrates as, and against existing data: check first whether any row already violates the pair, and say what was found
- [ ] The reasoning is recorded beside each converted key, in the form the three existing composite keys already use
