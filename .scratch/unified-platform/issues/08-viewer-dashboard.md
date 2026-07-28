# 08 — Viewer dashboard

PR batch: B

**What to build:** The first real dashboard. Someone with read-only access — including an anonymous demo visitor — opens the console and sees the facility's current exposure at a glance: how many cases are open, awaiting review and in the exception queue, which cases carry the most risk, and what signals the system is reacting to. They can search, filter, sort and page through those signals, and share the exact view they are looking at as a link.

Crucially, this ships while the score is still incomplete, and says so. Stock-level and supplier-concentration components stay dark until catalog data lands, and the dashboard states that rather than presenting a partial number as whole.

**Blocked by:** 03, 07

**Status:** ready-for-agent

- [ ] Open cases are ranked by risk score rather than by creation time
- [ ] Headline counts show open, awaiting-review and exception-queue cases
- [ ] Signals can be searched by drug name or identifier, and filtered by risk domain, severity and freshness
- [ ] Sorting and pagination work, and every list interaction is reflected in the page address so a view can be bookmarked or shared
- [ ] A hand-edited or malformed address degrades to sensible defaults rather than erroring
- [ ] Opening a signal shows its evidence, including a link to the originating source record and when it was last fetched
- [ ] A score displays its component breakdown, so its ranking is legible rather than asserted
- [ ] The dashboard states plainly which score components are unavailable pending catalog data
- [ ] An anonymous demo visitor can use the whole surface read-only and cannot mutate anything
