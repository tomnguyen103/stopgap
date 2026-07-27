# 13 — Daily brief

**What to build:** A director who does not watch the console all day still knows what changed. A daily brief summarises what moved, what is newly at risk, and what needs review.

The brief is drafted by a model but is built on the existing provider path, so it inherits health-check failover, cost and latency logging, and the established tracing. The absorbed codebase's own orchestration and hosted-tracing libraries are deliberately not adopted — a second of each would fragment observability.

**Blocked by:** 07

**Status:** ready-for-agent

- [ ] A brief is generated on a schedule and is readable in the console
- [ ] It summarises what changed since the previous brief and what needs review
- [ ] It is produced through structured output with schema validation, not free-form text parsing
- [ ] It runs on the existing provider registry with health-check failover, and a provider outage degrades rather than fails the brief
- [ ] Every model call emits a trace carrying provider, model, token counts, cost and latency
- [ ] Generated text passes the compliance guard before it is stored or displayed
- [ ] Briefs are tenant-scoped
- [ ] Generation runs on the durable workflow runtime; no second orchestrator is introduced
