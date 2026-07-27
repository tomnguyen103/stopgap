# 05 — Normalized signal contract, plus recall and device feeds

**What to build:** Every external feed speaks one shape. Today each source has its own bespoke structure, so adding a feed means touching the consumers. After this, a connector is a pure adapter — fetch, normalize, emit — and the rest of the system only ever sees a normalized signal. Two new feeds land on that contract at the same time, proving it: product recalls and device shortages, both of which matter directly here because substituting into a recalled alternative is the exact failure this pipeline exists to prevent.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] All existing feeds emit the same normalized signal type through one connector interface
- [ ] A connector performs no database writes, no scoring and no notification — purely fetch, normalize, emit
- [ ] Each signal carries source, risk domain, entity type and identifier, severity with a numeric severity for scoring, confidence, observation and publication times, last-fetched time, staleness, an evidence link, the retained raw payload, and match hints for later catalog association
- [ ] Deduplication unifies on the contract's stable key, scoped to organization and source
- [ ] "The source considers this resolved" and "the signal disappeared from the feed" remain distinct concepts and are not collapsed
- [ ] The default signal confidence is a single shared constant, so scoring and matching cannot drift apart
- [ ] Recalls and device shortages flow through the contract and are visible as signals
- [ ] Normalization is asserted against recorded payloads with no network access, and a repeated payload yields a stable key
