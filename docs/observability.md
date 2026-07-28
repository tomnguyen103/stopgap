# Observability (Phase 6 §6.4)

Stopgap exposes its health through a **pull-model** metrics stack: Prometheus scrapes two
targets, Grafana renders two provisioned dashboards over them, and Alertmanager routes the
alert rules. Nothing is pushed — the console and worker just expose `/metrics`-style endpoints
and Prometheus comes to them. This keeps the app free of monitoring credentials and lets the
whole stack come up with `docker compose up` and no secrets.

- **Console** — Prometheus metrics at `GET /api/metrics` (a Next.js route handler). Dev: host
  `http://localhost:3000`. Prod: compose service `console` on `:3000`.
- **Worker** — a tiny HTTP sidecar serving `/metrics`, `/healthz`, `/readyz` on `:9464`. Dev:
  host `http://localhost:9464`. Prod: compose service `worker` on `:9464`.
- **Grafana** — provisioned datasource + two dashboards (Ops, Business KPI), no manual setup.
- **Alertmanager** — receives fired rules. Dev (`deploy/alertmanager/alertmanager.yml`) uses a
  silent null receiver so `docker compose up` needs no secrets. Prod
  (`deploy/alertmanager/alertmanager.prod.yml`) routes to an on-call Slack channel and reads the
  webhook from the file named by `ALERTMANAGER_SLACK_WEBHOOK_FILE`; compose refuses to start
  without it, so a deployment cannot come up with alerting that pages nobody.

Dev ports bind to loopback only — Grafana `http://127.0.0.1:3002`, Alertmanager `127.0.0.1:9093`
(both are unauthenticated or default-credentialed, and Alertmanager can silence alerts);
Prometheus `:9090`. In production nothing publishes a port: Grafana is reached at
`https://$OPS_DOMAIN` through Caddy behind basic auth, and Alertmanager stays internal-only.

## Metrics

The console `/api/metrics` and the worker `/metrics` both expose the shortage-ops **gauges** (so
a snapshot is available even if one process is down). The **counters** are worker-only, because
comms, feed polling, and workflow activities all execute in the worker.

| Metric | Type | Meaning | Exposed on |
| --- | --- | --- | --- |
| `stopgap_cases_opened_today` | gauge | Shortage cases opened today | console + worker |
| `stopgap_exception_queue_depth` | gauge | Cases in the exception queue awaiting human resolution | console + worker |
| `stopgap_feed_staleness_seconds{source}` | gauge | Seconds since a source's newest stored feed record (`source="openfda"｜"ashp"｜…`) | console + worker |
| `stopgap_llm_daily_spend_usd` | gauge | Today's LLM spend in USD | console + worker |
| `stopgap_llm_daily_cap_usd` | gauge | Configured daily LLM cap in USD (`0` when no cap configured) | console + worker |
| `stopgap_ack_latency_seconds` | gauge | Average seconds from case open to acknowledgment | console + worker |
| `stopgap_critical_case_unacked_seconds` | gauge | Max age in seconds of an unacked critical case | console + worker |
| `stopgap_critical_case_unacked_count` | gauge | Count of unacknowledged critical cases | console + worker |
| `stopgap_comms_delivered_total{channel}` | counter | Comms delivered (`channel="email"｜"ehr"｜"escalation"`) | worker |
| `stopgap_comms_nondelivered_total{channel}` | counter | Comms recorded non-delivered (honest non-delivery, never faked) | worker |
| `stopgap_feed_poll_success_total` | counter | Successful feed polls | worker |
| `stopgap_retention_success_total` | counter | Organizations swept by the retention job (ticket 18) | worker |
| `stopgap_retention_failures_total` | counter | Organizations whose retention sweep threw; their expired rows remain and the next run retries them | worker |
| `stopgap_workflow_task_failures_total{activity}` | counter | Workflow activity failures (`activity="…"`) | worker |

## Health endpoints

Health (liveness/readiness) is separate from metrics — a load balancer or `docker` healthcheck
hits these, Prometheus hits `/metrics`.

- **`GET /api/healthz`** (console) — liveness. Always `200` if the process is up; no dependency
  checks. Use it to answer "is the console running."
- **`GET /api/readyz`** (console) — readiness. `200` when the console can reach its dependencies;
  `503` if the **DB or Temporal is down**. A `503` here means the console is up but cannot serve
  real work — pull it out of rotation, don't restart blindly.
- **Worker sidecar on `:9464`** — `/healthz` (liveness, up = `200`), `/readyz` (readiness, `503`
  when the worker can't reach its dependencies), and `/metrics` (the Prometheus scrape target).
  Killing the worker flips `/readyz` and, after 2m of missed scrapes, fires `WorkerDown`.

## Alerts and first-response runbooks

Rules live in `deploy/prometheus/alerts.yml`. Each alert's `description` links back to the
matching heading here. Fired alerts are visible in Prometheus (`:9090`) and Alertmanager
(`:9093`) even with no notifier wired.

### FeedStale

**Means:** some `stopgap_feed_staleness_seconds{source}` has exceeded 2700s (45 min) for 5m — a
feed source's newest stored record is stale. The `source` label names which one.

**First response:**
1. Note the `source` from the alert (e.g. `openfda`, `ashp`).
2. Check the feed poller / its schedule: is the worker up (`stopgap_feed_poll_success_total`
   still incrementing)? Has the polling schedule stopped firing?
3. Hit the upstream source manually to rule out an upstream outage vs. our poller.
4. If the poller is wedged, restart the worker (below); if upstream is down, the staleness is
   expected until it recovers — track, don't thrash.

### WorkerDown

**Means:** `up{job="stopgap-worker"} == 0` for 2m — Prometheus can't scrape the worker's
`:9464/metrics`. Workflows (comms, escalation, feed polling) are not advancing.

**First response:**
1. Check the worker process/container: `docker compose logs worker` (prod) or the host worker
   terminal (dev).
2. Restart the worker (`docker compose restart worker`, or restart the host process).
3. Confirm recovery: `/readyz` on `:9464` returns `200` and the scrape target goes green in
   Prometheus → Targets.

### ConsoleDown

**Means:** `up{job="stopgap-console"} == 0` for 2m — no `/api/metrics` scrape. The operator UI
and HITL review surface are down.

**First response:**
1. Check the console process/container logs.
2. Hit `/api/healthz` (liveness) and `/api/readyz` (readiness). `healthz` up but `readyz` `503`
   means the process is fine but the **DB or Temporal** is unreachable — chase that dependency
   rather than restarting the console.
3. Restart the console only if `healthz` itself is failing.

### SpendOver80PctCap

**Means:** `stopgap_llm_daily_cap_usd > 0` **and** spend/cap > 0.8 for 5m — today's LLM spend
has passed 80% of the configured daily cap. (The rule is guarded by `cap > 0`, so a
no-cap deployment never fires it.)

**First response:**
1. Inspect spend: `stopgap_llm_daily_spend_usd` vs `stopgap_llm_daily_cap_usd` on the Business
   KPI dashboard, and Langfuse for what's driving it.
2. The cap hard-stops LLM calls at 100% — decide whether to raise the cap (admin,
   `manage_spend_caps`) or let it stop new LLM work for the rest of the day.
3. If spend is climbing abnormally, look for a runaway/retrying workflow activity.

### CriticalCaseUnacked

**Means:** `stopgap_critical_case_unacked_seconds > 3600` for 1m — a critical case has been
unacknowledged past the 60-min policy limit. The gauge is the **max** unacked age across
critical cases, so one lagging case fires it.

**First response:**
1. Open the console exception/case queue; find the critical case(s) still unacknowledged.
2. **Page a pharmacist to acknowledge** — this is a policy-limit breach, not a system fault.
3. If no one is reachable, follow the escalation path; confirm the `escalation` comms channel
   is delivering (`stopgap_comms_delivered_total{channel="escalation"}`).
4. After ack, the gauge drops and the alert clears.

## Live verification

Bring the stack up with `docker compose up`. Then:

- **Dashboards render.** Open Grafana at `http://127.0.0.1:3002` (dev). Both provisioned
  dashboards appear under the **Stopgap** folder: **Ops** (feed freshness, worker liveness,
  exception depth, workflow failures, critical-unacked, comms) and **Business KPI** (spend vs
  cap, ack latency, cases opened, under-escalation, §14 SLO reference). Prometheus is at
  `:9090`, Alertmanager at `127.0.0.1:9093`.
- **FeedStale fires.** Stop the feed poller (or leave a source unpolled) and wait past 45 min of
  staleness + the 5m `for:` — `stopgap_feed_staleness_seconds` climbs on the Ops dashboard and
  `FeedStale` moves to firing in Prometheus → Alerts.
- **WorkerDown fires and `/readyz` flips.** Kill the worker. Its `/readyz` on `:9464` stops
  returning `200`, the `stopgap-worker` scrape target goes red, and after 2m `WorkerDown` fires.

Because targets are scraped (pull), a restarted console/worker re-appears on its own at the next
scrape — no re-registration step.
