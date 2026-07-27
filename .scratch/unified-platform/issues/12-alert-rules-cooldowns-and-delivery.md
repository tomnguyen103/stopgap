# 12 — Alert rules with cooldowns, reconciled with the escalation ladder

**What to build:** A director can say what should notify their team and how often, and those notifications reach the team where they already work. Two mechanisms currently overlap and must become one: rules decide what fires and when; the escalation ladder decides who is told and what happens if nobody acknowledges. They are reconciled here rather than run side by side.

Cooldowns are a correctness requirement, not a refinement. One recorded ingestion run opened fifty-seven cases; without cooldowns that is fifty-seven notifications from a single event, which teaches recipients to ignore the channel.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] Alert rules can be created, edited and deleted, scoped to items, categories and severities
- [ ] Each rule carries a cooldown, and a burst of matching signals within that window produces one notification rather than many
- [ ] Rule evaluation triggers; the escalation ladder owns ownership, acknowledgment and escalation on silence — the two do not duplicate each other
- [ ] Alert events are recorded with their outcome, so rules can be tuned against what actually fired
- [ ] Notifications deliver to a team chat channel as well as by email
- [ ] Delivery is idempotent — a retried send does not double-notify
- [ ] A missing chat credential is recorded as unconfigured and never faked as delivered
- [ ] Rules, events and delivery state are tenant-scoped with isolation coverage
