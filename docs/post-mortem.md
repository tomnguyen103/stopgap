# Post-mortem: what broke building Stopgap

The companion to the [writeup](writeup.md). Every entry is a real failure that happened during
this build, what caused it, and what caught it — because the failures are more instructive
than the parts that worked the first time.

---

## 1. Every case started from the deployed console died

**Symptom.** In the production docker rehearsal, starting a case from the console produced
`TypeError: Failed to initialize workflow of type 'aa': no such function is exported by the
workflow bundle`. The exact same code path worked in `pnpm dev`.

**Cause.** Cases were started with `client.workflow.start(shortageCaseWorkflow, …)`, passing
the imported function. Temporal derives the workflow type from `fn.name`. `next build`
minifies function names, so in the production console bundle `shortageCaseWorkflow.name` was
`"aa"` — a type the worker's bundle does not export.

**Why nothing caught it earlier.** Dev mode does not minify. The unit tests use the
time-skipping test server and start workflows by reference in an unbundled context. There is
no layer below "production build + real worker" where the names diverge, and nothing exercised
that layer until the deployment rehearsal.

**Fix.** Start workflows by string constant (`SHORTAGE_CASE_WORKFLOW`), never by function
reference. The worker still registers the real exports.

**Lesson.** A deployment rehearsal is not optional theatre. This class of bug — dev/prod
divergence in a build step — is invisible to every test that does not run the production
artifact.

## 2. Nothing had ever written `feed_records`

**Symptom.** Building the live-feed freshness panel for the demo, the query returned nothing,
on a database that had opened dozens of real cases from live openFDA.

**Cause.** The `feed_records` table shipped in Phase 1 as the provenance store behind
dedup — "which feed record opened this case". But the poll path (`pollAndOpenCases`) only ever
called `startCase`; it never persisted the records it fetched. The table had existed, empty,
for four phases. Every feature that would have read it had been deferred, so nothing noticed.

**Fix.** `pollAndOpenCases` now stores every fetched record before deciding what to open.
Verified against live openFDA: 100 records stored, the panel rendering a real timestamp.

**Lesson.** A schema is not a feature. A table with no writer is a latent bug that looks like
working code in every migration and every type. The freshness panel is what finally gave the
table a reader and exposed that it had no writer.

## 3. A dropped case when the model went away

**Symptom.** During the rehearsal, the host Ollama the containers pointed at went down. A
demo case sat at status `assessing` and never moved. Nothing in the UI said why.

**Cause.** The `assessImpact` activity retries five times, then the failure escapes. An
escaping activity failure fails the whole workflow — and a failed workflow leaves the case
frozen at its last persisted status, with no notification. That is a *dropped case*: the one
number PROJECT_PLAN §14 puts at zero, because a dropped shortage case is the exact failure
this system exists to prevent.

**Fix.** The two LLM activities are wrapped so an exhausted-retry failure becomes a value the
workflow can branch on, and an agent outage now parks the case in the exception queue with
reason `agent-unavailable` — which is what the queue is *for*: "the machine could not decide
this, a human must". Regression test added. The wrapper is deliberately not a catch-all; a
database write failing is a bug, and swallowing it would hide it.

**Lesson.** "Durable" means the *case* survives, not just the workflow engine. Temporal
guarantees the execution resumes; it does not guarantee the business outcome is acceptable.
The gap between "the workflow failed cleanly" and "the case reached a human" is exactly where
a dropped case hides.

## 4. The audit chain forked — and it was correct to

**Symptom.** During Phase 3 verification, `verifyAuditChain` reported a break at row 7 in the
dev database: 58 forked links.

**Investigation.** All 58 were inside one four-second window on 2026-07-23 20:14 — the 57-case
bulk poll. The cause was a stale pre-PR-#1 worker process still running *without* the
advisory-lock fix that serializes appends to the single global hash chain. Two unlocked
writers read the same chain tail and both chained to it.

**Resolution.** Not a code bug in current code: 12 concurrent `appendAudit` calls against the
same database produce zero forks. A fresh database does not reproduce it. The dev database
keeps the historical fork as an honest artifact rather than being rewritten — rewriting an
append-only audit log to make a verifier pass is precisely the thing the log exists to detect.

**Lesson.** The safety mechanism worked: a fork *was* detectable, and the detector found it.
The failure was operational (a stale process), and the right response to "the tamper-evidence
tripped" is to investigate provenance, not to silence the check.

## 5. The review's own findings

The two-axis local review of the first Phase 5 commit caught real problems before CodeRabbit
saw them — worth recording because they are the same class of mistake under time pressure:

- **A demo feature that changed production behaviour.** The daily spend cap was installed
  unconditionally, named `DEMO_DAILY_USD_CAP`, defaulting to $2. Any real deployment would
  have silently downgraded clinical calls to a 7B local model after $2/day. Renamed to
  `LLM_DAILY_USD_CAP`, off unless set, moved out of the demo package. A "demo" knob that
  quietly governs production is worse than no knob.
- **A rate limit that stopped limiting.** The scenario limit counted cases opened in the last
  hour — but a demo drug reuses one case row, so the count decayed to zero within the hour and
  the limit became unlimited. Now counts rows in a durable `demo_runs` table.

**Lesson.** The dangerous review findings are not the crashes; those surface themselves. They
are the things that *work in the demo* and are wrong everywhere else.

---

## Open weaknesses (measured, not hidden)

Carried forward in [PHASE5-TODO.md](../PHASE5-TODO.md):

- **No auth layer.** Reviewer identity is a claim. The public demo is read-only because of it.
- **Under-escalation on no-equivalent drugs.** The model invents a substitute where a
  pharmacist would say there is none — the dangerous direction. ~80–84% eval pass rate on a
  local 7B model, with the failures clustered here.
- **Direct severity-override injection** lands on some runs against a 7B model. Closed by
  construction on the demo (fixed drug catalogue, no free text) but real for the API.
- **The Gemini column is empty.** No API key in this environment; the frontier-model
  comparison is unrun rather than estimated.
- **The VPS is unprovisioned.** The compose stack was rehearsed locally; Caddy, the Temporal
  UI, Langfuse, and the in-cluster Ollama container were not exercised end to end.
