# Nightly shadow replay needed durable idempotence and local-provider lifecycle

## Symptom

The nightly `demo-seed` service could duplicate every corpus sample after a restart, leave the
second fixed demo tenant without shadow evidence, begin before the first Ollama model pull
completed, or inherit a paid `LLM_PROVIDER` setting and silently add no measured shadow rows.

## Root cause

`shadow_runs` had no replay-window key, so a second insert was a new random-id row. The service only
depended on migration completion (`deploy/docker-compose.prod.yml:266-270`), and its environment
was the shared application environment; the replay's local-provider cost invariant therefore
depended on operator configuration. Even after the replay validated Ollama, each agent call could
independently fail over to Gemini if Ollama went unhealthy. The replay command also targeted its
default seed tenant only, and a failed corpus item caused the next attempt to recompute earlier
successful entries before the database conflict check.

## Fix and receipt

`shadow_runs.replay_day` plus the partial unique `(org_id, corpus_id, replay_day)` index makes each
new UTC corpus sample idempotent for the daily window (`packages/db/src/schema.ts:635-674`).
Migration 0024 derives legacy days from `ran_at` and leaves same-day duplicate legacy rows with a
NULL day, preserving historical evidence while allowing the index to enforce new rows
(`packages/db/drizzle/0024_icy_barracuda.sql:1-25`). `recordShadowRun` returns the existing row on
a conflict (`packages/db/src/shadow.ts:14-43`); `hasShadowRunForReplay` lets the CLI skip an
already recorded entry before any model call (`packages/db/src/shadow.ts:55-73`,
`packages/shadow/scripts/replay.ts:42-50`). The replay runs both fixed demo tenants and exits
nonzero when any entry fails (`deploy/docker-compose.prod.yml:281-281`,
`packages/shadow/scripts/replay.ts:55-70`). `runShadowEntry` passes the validated Ollama provider
to both agents with health failover disabled, so an unhealthy second check fails the entry instead
of recording paid work as zero-cost evidence (`packages/shadow/src/run.ts:28-40`,
`packages/providers/src/route.ts:15-53`, `packages/providers/src/generate.ts:39-68`). The production
service retries the Ollama pull until the API/model is ready, overrides the replay environment to
Ollama, and retries a failed replay after five minutes (`deploy/docker-compose.prod.yml:128-139`,
`deploy/docker-compose.prod.yml:266-281`). The manual backfill commands also set
`LLM_PROVIDER=ollama` (`docs/deploy.md:51-52`). These behaviors are covered by
`packages/db/src/shadow.test.ts`, `packages/providers/src/route.test.ts` and
`packages/shadow/src/run.test.ts`.
