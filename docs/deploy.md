# Deploy runbook (single VPS)

Everything Stopgap needs runs on one host with `docker compose` (PROJECT_PLAN §11): console,
worker, Temporal + UI, one Postgres holding three databases, Langfuse, a CPU Ollama, and
Caddy for TLS.

**Status: written and verified locally, not provisioned.** The compose stack in this
directory was built and started on a local Docker daemon; no paid VPS has been rented for it.
Everything below is the procedure, not a description of a running deployment. The one thing
that cannot be verified without the host is Let's Encrypt issuance, which needs public DNS.

## Sizing and cost

| | |
|---|---|
| Host | 4 vCPU / 8 GB (Hetzner CX32 class). 8 GB is driven by Ollama + ClickHouse, not the app |
| Disk | 40 GB+ — a 7B model is ~4 GB, ClickHouse grows with trace volume |
| Cost | ~€8–15/mo host, plus $0–5/mo model spend depending on `LLM_PROVIDER` |

If Langfuse is dropped (no ClickHouse/Redis/MinIO), 4 GB is enough — tracing then goes dark,
which is a real loss: it is the only per-call record of what the model was asked and answered.

## First deploy

1. **DNS.** Point `APP_DOMAIN`, `TEMPORAL_DOMAIN`, `TRACES_DOMAIN` at the host. Caddy cannot
   issue certificates before these resolve.
2. **Clone and configure.**
   ```bash
   git clone https://github.com/tomnguyen103/stopgap.git && cd stopgap/deploy
   cp .env.prod.example .env
   ```
   Fill every secret. `openssl rand -hex 32` for the random ones;
   `caddy hash-password --plaintext '<pw>'` for `BASIC_AUTH_HASH` — **double every `$` in
   that hash**, because docker compose interpolates `$` in `.env` and a truncated hash
   silently matches nothing; `LANGFUSE_ENCRYPTION_KEY` must be exactly 64 hex characters.
3. **Start.**
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
   Order is enforced by the compose file: Postgres → `migrate` (one-shot) → console/worker.
   `ollama-pull` fetches the model once so the first case does not wait on a multi-GB download.
4. **Open the case schedule** — nothing polls the feeds until this runs once:
   ```bash
   docker compose -f docker-compose.prod.yml exec worker pnpm --filter @stopgap/workflows start-schedule
   ```
5. **Populate the shadow dashboard with real numbers** (optional, ~10 min on CPU Ollama):
   ```bash
   docker compose -f docker-compose.prod.yml exec worker pnpm --filter @stopgap/shadow replay
   ```
   The demo seeder deliberately does not write shadow rows — every agreement figure on
   `/shadow` should be one that was actually measured on this host.

## What is exposed

| URL | Who can reach it | Why |
|---|---|---|
| `https://$APP_DOMAIN` | public | demo mode: read-only, reviews refused server-side |
| `https://$TEMPORAL_DOMAIN` | basic auth | shows real durable workflows — and can terminate them |
| `https://$TRACES_DOMAIN` | basic auth | Langfuse; prompts and case text are visible in spans |

No container publishes a port except Caddy. **There is still no application auth layer**
(PHASE5-TODO.md): demo mode is what makes the public console safe, by refusing every
mutation except starting a demo shortage. Turning `STOPGAP_DEMO_MODE=off` on a
publicly-reachable host means anyone who finds it can approve clinical guidance.

## Demo mode

- `STOPGAP_DEMO_MODE=on` — reviews and exception resolutions are refused in the server
  action, not merely hidden in the UI.
- **"Run a shortage"** starts a real Temporal case through the real agents. The drug comes
  from a fixed catalogue (never free text, so a visitor cannot reach the prompt), keys are
  `demo-` prefixed so a demo run cannot collide with a live openFDA case, and starts are
  limited to `DEMO_MAX_RUNS_PER_HOUR` counted from the case table.
- **Budget cap.** Every LLM call's cost is added to a daily row (`llm_spend`); at
  `DEMO_DAILY_USD_CAP` routing switches to the free local model and the banner says so. The
  demo degrades to a smaller model rather than going dark.
- **Nightly re-seed** (`demo-seed` service) parks three cases at day 2 / 18 / 45 with the
  protocol history behind them. It updates rather than deletes: `audit_log` is an append-only
  hash chain and a tidy-up would break verification for every later row.

## Operating

```bash
# logs
docker compose -f docker-compose.prod.yml logs -f worker console

# apply a new migration after pulling
docker compose -f docker-compose.prod.yml run --rm migrate

# re-seed the demo now
docker compose -f docker-compose.prod.yml exec demo-seed pnpm --filter @stopgap/demo seed

# audit-chain check
docker compose -f docker-compose.prod.yml exec worker \
  pnpm --filter @stopgap/db exec tsx -e "import {getDb,verifyAuditChain} from './src/index.js'; console.log(await verifyAuditChain(getDb()))"
```

**Upgrades** are `git pull && docker compose -f docker-compose.prod.yml up -d --build`. Schema
changes and worker code must ship together — a worker running against a newer audit schema
than its own code fails cases with duplicate-key errors.

**Backups**: the only irreplaceable volume is `pgdata` (cases, audit chain, protocols).
`docker compose exec postgres pg_dump -U stopgap stopgap | gzip > stopgap-$(date +%F).sql.gz`,
off-host. ClickHouse holds traces (nice to have) and the Ollama volume is a re-downloadable
model.

## Local rehearsal (how this was verified)

`docker-compose.localcheck.yml` is an override for exactly this: it publishes the console on
`localhost:3100` and points the containers at a host Ollama, so the whole stack can be
exercised without DNS, a certificate, or a model download.

```bash
cd deploy
cp .env.prod.example .env   # throwaway values are fine here
docker compose -f docker-compose.prod.yml -f docker-compose.localcheck.yml \
  up -d --build postgres temporal migrate console worker
docker compose -f docker-compose.prod.yml -f docker-compose.localcheck.yml \
  exec worker pnpm --filter @stopgap/demo seed
```

Verified this way on 2026-07-23: migrations applied, seeder produced the day 2 / 18 / 45
cases, "Run a shortage" started a real case that ran through the live agents to
`awaiting_review` with a hash-chained audit trail, the review gate showed as disabled, and
the `llm_spend` row counted the two model calls the case made.

That rehearsal is also what caught the one bug this deployment path had: `next build`
minifies function names, so starting a workflow by passing the imported function sent
Temporal the workflow type `aa`. Workflows are now started by name
(`SHORTAGE_CASE_WORKFLOW`). Nothing in dev mode or the unit tests could have surfaced it —
only a production build could.

Caddy is the one service the rehearsal cannot cover: it needs public DNS to issue a
certificate.
